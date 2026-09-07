#!/usr/bin/env python3
"""
The auth chain, end to end:

    Keycloak  --token-->  agentgateway  --passthrough-->  mcp-openapi  -->  Harbor

It asserts the things that are easy to believe without checking:

  * an unauthenticated call is refused *at the gateway*, not later
  * a forged token is refused too, so the 401 is validation and not a missing header
  * the ID token really carries both audiences — the gateway's and Harbor's
  * a full MCP handshake succeeds through the gateway
  * the identity tool comes back with the *caller's* username, which is the only
    proof the identity survived all three hops rather than being replaced by a
    service account somewhere in the middle
  * an operation in the document but absent from the allowlist is not exposed
  * two different users resolve to two different Harbor identities

This is the chain check. For a thorough exercise of mcp-openapi against the real
Harbor — reads with real parameters, a write, per-caller permissions, failure
modes — see test-openapi-e2e.py.

Credentials come from lab.env, so nothing here has a usable default.

Usage:
    python3 smoke-test.py
    python3 smoke-test.py --user alice --password "$LAB_USER_ALICE_PASSWORD"
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request

KC = "https://keycloak.192.168.1.200.nip.io"
MCP = "https://mcp.192.168.1.200.nip.io"
REALM = "lab"

# mcp-openapi is the only server behind the gateway; mcp-harbor is scaled to
# zero and unrouted. Tool names come from Harbor's operationIds, prefixed by the
# MCP_TOOL_PREFIX the deployment sets.
WHOAMI = "openapi_getCurrentUserInfo"
NOT_ALLOWLISTED = "openapi_updateProject"

# Upstream error text can contain characters a cp1252 console cannot encode.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE  # private lab CA

PASS, FAIL = "  ok  ", " FAIL "
failures: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    print(f"[{PASS if cond else FAIL}] {name}" + (f"  — {detail}" if detail else ""))
    if not cond:
        failures.append(name)


def lab_env(name: str) -> str | None:
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


JSON_HEADERS = {
    "Content-Type": "application/json",
    # Both are required by the streamable HTTP transport; sending only
    # application/json gets a 406 that reads like a server bug.
    "Accept": "application/json, text/event-stream",
}


def post(url: str, data: bytes, headers: dict[str, str]) -> tuple[int, dict[str, str], bytes]:
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, context=CTX, timeout=60) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


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


def body_json(raw: bytes) -> dict:
    """The transport answers as JSON or as a one-event SSE stream."""
    text = raw.decode("utf-8", "replace").strip()
    if text.startswith(("event:", "data:")):
        for line in text.splitlines():
            if line.startswith("data:"):
                return json.loads(line[5:].strip())
        return {}
    return json.loads(text) if text else {}


def rpc(session: str | None, token: str, method: str, params: dict | None = None,
        rid: int | None = 1) -> tuple[int, dict[str, str], bytes]:
    payload: dict = {"jsonrpc": "2.0", "method": method}
    if rid is not None:
        payload["id"] = rid
    if params is not None:
        payload["params"] = params
    headers = {**JSON_HEADERS, "Authorization": f"Bearer {token}"}
    if session:
        headers["Mcp-Session-Id"] = session
    return post(f"{MCP}/mcp", json.dumps(payload).encode(), headers)


INIT = {
    "protocolVersion": "2025-06-18",
    "capabilities": {},
    "clientInfo": {"name": "smoke-test", "version": "1.0"},
}


def open_session(token: str) -> tuple[str | None, dict]:
    code, headers, raw = rpc(None, token, "initialize", INIT)
    session = headers.get("Mcp-Session-Id") or headers.get("mcp-session-id")
    rpc(session, token, "notifications/initialized", rid=None)
    return session, {"code": code, "body": body_json(raw), "raw": raw}


def tool_text(session: str | None, token: str, name: str, rid: int) -> tuple[bool, dict]:
    _, _, raw = rpc(session, token, "tools/call", {"name": name, "arguments": {}}, rid=rid)
    result = body_json(raw).get("result", {})
    text = (result.get("content") or [{}])[0].get("text", "")
    try:
        return bool(result.get("isError")), json.loads(text)
    except Exception:
        return bool(result.get("isError")), {"_text": text}


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
    idt = get_token(args.user, args.password)["id_token"]
    c = claims(idt)
    aud = c.get("aud")
    aud = aud if isinstance(aud, list) else [aud]
    check("id_token issued", bool(idt))
    check("iss is the public Keycloak URL", c.get("iss") == f"{KC}/realms/{REALM}", c.get("iss", ""))
    check("aud contains mcp-gateway (for agentgateway)", "mcp-gateway" in aud, str(aud))
    check("aud contains harbor (for the Harbor API)", "harbor" in aud, str(aud))
    check("subject is the caller", c.get("preferred_username") == args.user,
          str(c.get("preferred_username")))

    print("\n=== 2. the gateway refuses unauthenticated MCP ===")
    probe = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}).encode()
    code, _, _ = post(f"{MCP}/mcp", probe, JSON_HEADERS)
    check("no token -> 401 at the gateway", code == 401, f"HTTP {code}")
    code, _, _ = post(f"{MCP}/mcp", probe, {**JSON_HEADERS, "Authorization": "Bearer not-a-token"})
    check("forged token -> 401 at the gateway", code == 401, f"HTTP {code}")

    print("\n=== 3. MCP handshake through the gateway ===")
    session, init = open_session(idt)
    check("initialize accepted", init["code"] == 200, f"HTTP {init['code']}")
    if init["code"] != 200:
        return 1
    check("gateway issued a session id", bool(session), session or "none")

    # With a single target the gateway passes the backend's identity through;
    # with several it answers as "agentgateway" and aggregates them.
    server_name = init["body"].get("result", {}).get("serverInfo", {}).get("name")
    check("the server behind the gateway is mcp-openapi", server_name == "mcp-openapi",
          str(server_name))

    print("\n=== 4. the allowlist is the surface ===")
    _, _, raw = rpc(session, idt, "tools/list", rid=2)
    tools = [t["name"] for t in body_json(raw).get("result", {}).get("tools", [])]
    check("tools/list works", bool(tools), f"{len(tools)} tools")
    check("the identity tool is present", WHOAMI in tools, ", ".join(sorted(tools)[:3]) + "…")
    check("every tool comes from the generic server", all(t.startswith("openapi_") for t in tools),
          "mcp-harbor is scaled to zero and unrouted")
    check(f"{NOT_ALLOWLISTED} is not exposed", NOT_ALLOWLISTED not in tools,
          "it is in the document; the allowlist does not select it")

    print("\n=== 5. the identity reaches Harbor ===")
    is_error, who = tool_text(session, idt, WHOAMI, 3)
    check(f"{WHOAMI} succeeded", not is_error, str(who)[:120])
    check(f"Harbor sees the caller as '{args.user}'", who.get("username") == args.user,
          f"got {who.get('username')!r}")

    print("\n=== 6. a second user is not the first ===")
    idt2 = get_token(args.also_user, args.also_password)["id_token"]
    session2, _ = open_session(idt2)
    is_error2, who2 = tool_text(session2, idt2, WHOAMI, 4)
    check(f"Harbor sees the second caller as '{args.also_user}'",
          who2.get("username") == args.also_user, f"got {who2.get('username')!r}")
    check("the two callers are distinct identities",
          who.get("user_id") is not None and who.get("user_id") != who2.get("user_id"),
          f"{who.get('user_id')} vs {who2.get('user_id')}")

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
