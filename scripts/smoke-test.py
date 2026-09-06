#!/usr/bin/env python3
"""
End-to-end check of the whole chain:

    Keycloak  --token-->  agentgateway  --passthrough-->  mcp-harbor  -->  Harbor

It asserts the things that are easy to believe without checking:

  * an unauthenticated call is refused *at the gateway*, not later
  * the ID token really carries both audiences (gateway's and Harbor's)
  * a full MCP handshake succeeds through the gateway
  * harbor_whoami comes back with the *caller's* username, which is the only
    proof the identity survived all three hops rather than being replaced by a
    service account somewhere in the middle
  * the generic OpenAPI-driven server is mounted alongside the hand-written one
    and resolves the same caller
  * an operation present in the spec but absent from the allowlist is not
    exposed as a tool
  * two different users see themselves, not each other

Credentials come from lab.env (or the matching environment variables), so
nothing here has a usable default.

Usage:
    python3 smoke-test.py
    python3 smoke-test.py --user alice --password "$LAB_USER_ALICE_PASSWORD"
"""

from __future__ import annotations

import argparse
import base64
import json
import ssl
import sys
import os
import urllib.error
import urllib.parse
import urllib.request


def lab_env(name: str) -> str | None:
    """Read a value from the environment, falling back to ../lab.env."""
    if os.environ.get(name):
        return os.environ[name]
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lab.env")
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line.startswith(f"{name}="):
                    return line.split("=", 1)[1].strip().strip("\"'")
    except FileNotFoundError:
        pass
    return None


KC = "https://keycloak.192.168.1.200.nip.io"
MCP = "https://mcp.192.168.1.200.nip.io"
REALM = "lab"

CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE  # lab CA; pass --ca-file to verify properly

PASS, FAIL = "  ok  ", " FAIL "
failures: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    print(f"[{PASS if cond else FAIL}] {name}" + (f"  — {detail}" if detail else ""))
    if not cond:
        failures.append(name)


def post(url: str, data: bytes, headers: dict[str, str]) -> tuple[int, dict[str, str], bytes]:
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, context=CTX, timeout=30) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def get(url: str, headers: dict[str, str] | None = None) -> tuple[int, bytes]:
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(req, context=CTX, timeout=30) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def claims(tok: str) -> dict:
    p = tok.split(".")[1]
    p += "=" * (-len(p) % 4)
    return json.loads(base64.urlsafe_b64decode(p))


def get_token(user: str, password: str) -> dict:
    body = urllib.parse.urlencode(
        {
            "grant_type": "password",
            "client_id": "mcp",
            "username": user,
            "password": password,
            "scope": "openid profile email",
        }
    ).encode()
    code, _, raw = post(
        f"{KC}/realms/{REALM}/protocol/openid-connect/token",
        body,
        {"Content-Type": "application/x-www-form-urlencoded"},
    )
    if code != 200:
        print(f"token request failed: HTTP {code}: {raw[:300]!r}", file=sys.stderr)
        raise SystemExit(1)
    return json.loads(raw)


JSON_HEADERS = {
    "Content-Type": "application/json",
    # Both are required by the streamable HTTP transport; sending only
    # application/json gets a 406 that reads like a server bug.
    "Accept": "application/json, text/event-stream",
}


def rpc(session: str | None, token: str, method: str, params: dict | None = None, rid: int | None = 1):
    payload: dict = {"jsonrpc": "2.0", "method": method}
    if rid is not None:
        payload["id"] = rid
    if params is not None:
        payload["params"] = params
    headers = dict(JSON_HEADERS)
    headers["Authorization"] = f"Bearer {token}"
    if session:
        headers["Mcp-Session-Id"] = session
    return post(f"{MCP}/mcp", json.dumps(payload).encode(), headers)


def body_json(raw: bytes) -> dict:
    """The transport may answer as JSON or as a one-event SSE stream."""
    text = raw.decode("utf-8", "replace").strip()
    if text.startswith("event:") or text.startswith("data:"):
        for line in text.splitlines():
            if line.startswith("data:"):
                return json.loads(line[5:].strip())
        return {}
    return json.loads(text) if text else {}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--user", default="dev")
    ap.add_argument("--password", default=None)
    ap.add_argument("--also-user", default="alice")
    ap.add_argument("--also-password", default=None)
    args = ap.parse_args()

    args.password = args.password or lab_env("LAB_USER_DEV_PASSWORD")
    args.also_password = args.also_password or lab_env("LAB_USER_ALICE_PASSWORD")
    if not args.password or not args.also_password:
        print(
            "no password: pass --password/--also-password, or create lab.env "
            "with ./init-secrets.sh",
            file=sys.stderr,
        )
        return 1

    print(f"\n=== 1. Keycloak issues a token for {args.user} ===")
    tok = get_token(args.user, args.password)
    idt = tok["id_token"]
    c = claims(idt)
    aud = c.get("aud")
    aud = aud if isinstance(aud, list) else [aud]
    check("id_token issued", bool(idt))
    check("iss is the public Keycloak URL", c.get("iss") == f"{KC}/realms/{REALM}", c.get("iss", ""))
    check("aud contains mcp-gateway (for agentgateway)", "mcp-gateway" in aud, str(aud))
    check("aud contains harbor (for the Harbor API)", "harbor" in aud, str(aud))
    check("subject is the caller", c.get("preferred_username") == args.user, str(c.get("preferred_username")))

    print("\n=== 2. the gateway refuses unauthenticated MCP ===")
    code, _, _ = post(f"{MCP}/mcp", json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}).encode(), JSON_HEADERS)
    check("no token -> 401 at the gateway", code == 401, f"HTTP {code}")

    code, _, _ = post(
        f"{MCP}/mcp",
        json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}).encode(),
        {**JSON_HEADERS, "Authorization": "Bearer not-a-real-token"},
    )
    check("garbage token -> 401 at the gateway", code == 401, f"HTTP {code}")

    print("\n=== 3. MCP handshake through the gateway ===")
    code, headers, raw = rpc(
        None,
        idt,
        "initialize",
        {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "smoke-test", "version": "1.0"},
        },
    )
    check("initialize accepted", code == 200, f"HTTP {code} {raw[:200]!r}")
    if code != 200:
        return 1

    session = headers.get("Mcp-Session-Id") or headers.get("mcp-session-id")
    check("gateway issued a session id", bool(session), session or "none")

    init = body_json(raw)
    server_name = init.get("result", {}).get("serverInfo", {}).get("name")
    # agentgateway answers as itself once it multiplexes more than one target:
    # the client is talking to the gateway, which aggregates the backends. The
    # backends are identified by their tool namespaces instead, checked below.
    check("the gateway answered initialize", server_name == "agentgateway", str(server_name))

    # The transport requires this notification before normal traffic.
    rpc(session, idt, "notifications/initialized", rid=None)

    print("\n=== 4. tools are exposed ===")
    code, _, raw = rpc(session, idt, "tools/list", rid=2)
    tools = [t["name"] for t in body_json(raw).get("result", {}).get("tools", [])]
    check("tools/list works", code == 200 and bool(tools), f"{len(tools)} tools")
    check("harbor_whoami present", "harbor_whoami" in tools, ", ".join(tools[:4]) + "…")

    print("\n=== 5. the identity reaches Harbor ===")
    code, _, raw = rpc(session, idt, "tools/call", {"name": "harbor_whoami", "arguments": {}}, rid=3)
    res = body_json(raw).get("result", {})
    text = (res.get("content") or [{}])[0].get("text", "")
    is_error = res.get("isError", False)
    who = {}
    try:
        who = json.loads(text)
    except Exception:
        pass
    check("harbor_whoami succeeded", code == 200 and not is_error, text[:200])
    check(
        f"Harbor sees the caller as '{args.user}'",
        who.get("username") == args.user,
        f"got {who.get('username')!r}",
    )

    print("\n=== 6. the generic OpenAPI server is mounted alongside ===")
    # mcp-openapi builds its tools from Harbor's own OpenAPI document, filtered
    # by an allowlist. Its presence here proves the gateway multiplexes both
    # servers and that the same forwarded token reaches both.
    generic = [t for t in tools if t.startswith("openapi_")]
    check("openapi_* tools are present", bool(generic), f"{len(generic)} of {len(tools)}")
    check(
        "an operation absent from the allowlist is not exposed",
        not any(t.startswith("openapi_createProject") for t in tools),
        "POST /projects exists in the spec and is not allowlisted",
    )

    if generic:
        code, _, raw = rpc(
            session, idt, "tools/call",
            {"name": "openapi_getCurrentUserInfo", "arguments": {}}, rid=7,
        )
        gres = body_json(raw).get("result", {})
        gtext = (gres.get("content") or [{}])[0].get("text", "")
        gwho = {}
        try:
            gwho = json.loads(gtext)
        except Exception:
            pass
        check(
            f"the generic server also resolves the caller as '{args.user}'",
            gwho.get("username") == args.user,
            f"got {gwho.get('username')!r}",
        )

    print("\n=== 7. a second user is not the first ===")
    tok2 = get_token(args.also_user, args.also_password)
    idt2 = tok2["id_token"]
    code, headers2, raw = rpc(
        None,
        idt2,
        "initialize",
        {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "smoke-test", "version": "1.0"}},
    )
    session2 = headers2.get("Mcp-Session-Id") or headers2.get("mcp-session-id")
    rpc(session2, idt2, "notifications/initialized", rid=None)
    code, _, raw = rpc(session2, idt2, "tools/call", {"name": "harbor_whoami", "arguments": {}}, rid=8)
    text2 = (body_json(raw).get("result", {}).get("content") or [{}])[0].get("text", "")
    who2 = {}
    try:
        who2 = json.loads(text2)
    except Exception:
        pass
    check(
        f"Harbor sees the second caller as '{args.also_user}'",
        who2.get("username") == args.also_user,
        f"got {who2.get('username')!r}",
    )
    check(
        "the two callers are distinct identities",
        who.get("user_id") is not None and who.get("user_id") != who2.get("user_id"),
        f"{who.get('user_id')} vs {who2.get('user_id')}",
    )

    print()
    if failures:
        print(f"{len(failures)} check(s) failed:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
