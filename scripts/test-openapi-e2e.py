#!/usr/bin/env python3
"""
End-to-end test of mcp-openapi against the real Harbor, through agentgateway.

mcp-harbor is out of the request path: this exercises the template server alone,
built from Harbor's own OpenAPI document at start-up, with nothing hand-written
about Harbor anywhere in it.

What it establishes, in order:

  the surface     only what the allowlist selects is listed or callable
  the identity    Harbor resolves each caller to that person, not a shared account
  reads           path, query and templated parameters reach the real API
  a write         POST /projects, which is the Swagger 2.0 `in: body` path
  authorisation   Harbor's own permissions still apply per caller
  failures        bad arguments, unknown tools, upstream errors

It cleans up the project it creates, and is safe to re-run.

Usage:
    python3 test-openapi-e2e.py
    python3 test-openapi-e2e.py --keep     # leave the created project behind
"""

from __future__ import annotations

import argparse
import base64
import json
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

KC = "https://keycloak.192.168.1.200.nip.io"
MCP = "https://mcp.192.168.1.200.nip.io"
REALM = "lab"

# The upstream's error messages contain characters cp1252 cannot encode, and a
# Windows console defaults to it. Without this the test dies printing a result
# rather than computing one.
for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE  # private lab CA

PASS, FAIL, INFO = "  ok  ", " FAIL ", " ---- "
failures: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> bool:
    print(f"[{PASS if cond else FAIL}] {name}" + (f"  — {detail}" if detail else ""))
    if not cond:
        failures.append(name)
    return cond


def note(text: str) -> None:
    print(f"[{INFO}] {text}")


def lab_env(name: str) -> str | None:
    import os

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


# ─────────────────────────────────────────────────────────────────────────────
# transport
# ─────────────────────────────────────────────────────────────────────────────

HEADERS = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
}


def post(url: str, data: bytes, headers: dict[str, str]) -> tuple[int, dict[str, str], bytes]:
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, context=CTX, timeout=60) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def token_for(user: str, password: str) -> str:
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
        sys.exit(f"token request for {user} failed: HTTP {code}: {raw[:300]!r}")
    return json.loads(raw)["id_token"]


def body_json(raw: bytes) -> dict:
    """The transport answers as JSON or as a one-event SSE stream."""
    text = raw.decode("utf-8", "replace").strip()
    if text.startswith(("event:", "data:")):
        for line in text.splitlines():
            if line.startswith("data:"):
                return json.loads(line[5:].strip())
        return {}
    return json.loads(text) if text else {}


class Session:
    """One MCP session through the gateway, for one caller."""

    def __init__(self, token: str, label: str) -> None:
        self.token = token
        self.label = label
        self.id: str | None = None
        self._rid = 0

    def _headers(self) -> dict[str, str]:
        h = {**HEADERS, "Authorization": f"Bearer {self.token}"}
        if self.id:
            h["Mcp-Session-Id"] = self.id
        return h

    def rpc(self, method: str, params: dict | None = None, notify: bool = False) -> dict:
        payload: dict = {"jsonrpc": "2.0", "method": method}
        if not notify:
            self._rid += 1
            payload["id"] = self._rid
        if params is not None:
            payload["params"] = params
        status, headers, raw = post(f"{MCP}/mcp", json.dumps(payload).encode(), self._headers())
        if self.id is None:
            self.id = headers.get("Mcp-Session-Id") or headers.get("mcp-session-id")
        return {"status": status, "body": body_json(raw)}

    def open(self) -> dict:
        res = self.rpc(
            "initialize",
            {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "e2e", "version": "1"},
            },
        )
        self.rpc("notifications/initialized", notify=True)
        return res

    def tools(self) -> list[str]:
        res = self.rpc("tools/list")
        return [t["name"] for t in res["body"].get("result", {}).get("tools", [])]

    def call(self, name: str, args: dict | None = None) -> dict:
        """Return {isError, text, data} for a tool call."""
        res = self.rpc("tools/call", {"name": name, "arguments": args or {}})
        result = res["body"].get("result", {})
        text = (result.get("content") or [{}])[0].get("text", "")
        data = None
        try:
            data = json.loads(text)
        except Exception:
            pass
        return {"isError": bool(result.get("isError")), "text": text, "data": data}


# ─────────────────────────────────────────────────────────────────────────────

EXPECTED_TOOLS = {
    "openapi_getCurrentUserInfo",
    "openapi_getHealth",
    "openapi_getStatistic",
    "openapi_getSystemInfo",
    "openapi_search",
    "openapi_listProjects",
    "openapi_getProject",
    "openapi_listRepositories",
    "openapi_listArtifacts",
    "openapi_createProject",
    "openapi_deleteProject",
}

# In the document, absent from the allowlist. Neither may be listed or callable.
FORBIDDEN_TOOLS = ["openapi_updateProject", "openapi_createRegistry", "openapi_listAuditLogs"]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep", action="store_true", help="do not delete the project it creates")
    args = ap.parse_args()

    dev_pw = lab_env("LAB_USER_DEV_PASSWORD")
    alice_pw = lab_env("LAB_USER_ALICE_PASSWORD")
    if not dev_pw or not alice_pw:
        print("no lab.env; run ./scripts/init-secrets.sh", file=sys.stderr)
        return 1

    project = f"e2e-{int(time.time())}"

    print("\n=== 1. the gateway is the only way in ===")
    status, _, _ = post(
        f"{MCP}/mcp",
        json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}).encode(),
        HEADERS,
    )
    check("no token is refused at the gateway", status == 401, f"HTTP {status}")
    status, _, _ = post(
        f"{MCP}/mcp",
        json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}).encode(),
        {**HEADERS, "Authorization": "Bearer nonsense"},
    )
    check("a forged token is refused at the gateway", status == 401, f"HTTP {status}")

    print("\n=== 2. handshake, with mcp-harbor out of the path ===")
    dev = Session(token_for("dev", dev_pw), "dev")
    opened = dev.open()
    check("initialize succeeds", opened["status"] == 200, f"HTTP {opened['status']}")
    check("the gateway issued a session", dev.id is not None)

    print("\n=== 3. the allowlist is the surface ===")
    tools = set(dev.tools())
    check("every allowlisted operation is a tool", tools == EXPECTED_TOOLS,
          f"{len(tools)} tools" if tools == EXPECTED_TOOLS else f"got {sorted(tools)}")
    check("no hand-written harbor_* tool remains", not any(t.startswith("harbor_") for t in tools),
          "mcp-harbor is scaled to zero and unrouted")
    for name in FORBIDDEN_TOOLS:
        check(f"{name} is not exposed", name not in tools)

    print("\n=== 4. the identity reaches Harbor ===")
    me = dev.call("openapi_getCurrentUserInfo")
    check("getCurrentUserInfo succeeds", not me["isError"], me["text"][:120])
    dev_id = (me["data"] or {}).get("user_id")
    check("Harbor sees the caller as 'dev'", (me["data"] or {}).get("username") == "dev",
          f"user_id={dev_id}")

    print("\n=== 5. reads, with real parameters ===")
    health = dev.call("openapi_getHealth")
    check("getHealth returns component status", not health["isError"]
          and "components" in (health["data"] or {}),
          f"status={(health['data'] or {}).get('status')}")

    info = dev.call("openapi_getSystemInfo")
    check("getSystemInfo confirms Harbor is in OIDC mode",
          (info["data"] or {}).get("auth_mode") == "oidc_auth",
          str((info["data"] or {}).get("auth_mode")))

    listed = dev.call("openapi_listProjects")
    check("listProjects returns a list", not listed["isError"] and isinstance(listed["data"], list),
          f"{len(listed['data']) if isinstance(listed['data'], list) else '?'} project(s)")

    paged = dev.call("openapi_listProjects", {"page": 1, "page_size": 1})
    check("query parameters reach the API",
          not paged["isError"] and isinstance(paged["data"], list) and len(paged["data"]) <= 1,
          f"{len(paged['data']) if isinstance(paged['data'], list) else '?'} returned with page_size=1")

    repos = dev.call("openapi_listRepositories", {"project_name": "library"})
    check("a templated path parameter reaches the API", not repos["isError"], repos["text"][:80])

    found = dev.call("openapi_search", {"q": "library"})
    check("search returns the library project",
          not found["isError"] and any(
              p.get("name") == "library" for p in (found["data"] or {}).get("project", [])),
          "")

    print("\n=== 6. a write: POST with a Swagger 2.0 in:body parameter ===")
    note(f"creating project {project!r}")
    created = dev.call("openapi_createProject", {"body": {"project_name": project, "metadata": {"public": "false"}}})
    ok_created = check("createProject succeeds", not created["isError"], created["text"][:200])

    if ok_created:
        fetched = dev.call("openapi_getProject", {"project_name_or_id": project})
        check("the created project is readable back",
              not fetched["isError"] and (fetched["data"] or {}).get("name") == project,
              str((fetched["data"] or {}).get("name")))
        check("Harbor recorded 'dev' as its owner",
              (fetched["data"] or {}).get("owner_name") == "dev",
              str((fetched["data"] or {}).get("owner_name")))

    print("\n=== 7. Harbor's own permissions still apply, per caller ===")
    alice = Session(token_for("alice", alice_pw), "alice")
    alice.open()
    alice_me = alice.call("openapi_getCurrentUserInfo")
    alice_id = (alice_me["data"] or {}).get("user_id")
    check("Harbor sees the second caller as 'alice'",
          (alice_me["data"] or {}).get("username") == "alice", f"user_id={alice_id}")
    check("the two callers are distinct Harbor identities",
          dev_id is not None and dev_id != alice_id, f"{dev_id} vs {alice_id}")

    if ok_created:
        # dev's project is private, so alice must not see it. This is Harbor
        # enforcing its own model on the forwarded identity — nothing in the MCP
        # server knows what a private project is.
        alice_projects = alice.call("openapi_listProjects")
        names = [p.get("name") for p in (alice_projects["data"] or [])]
        check("a private project is invisible to the other caller", project not in names,
              f"alice sees {names}")

        denied = alice.call("openapi_deleteProject", {"project_name_or_id": project})
        check("the other caller may not delete it", denied["isError"], denied["text"][:100])
        check("and the refusal explains itself", "403" in denied["text"] or "not allowed" in denied["text"].lower(),
              denied["text"][:100])

    print("\n=== 8. failure modes ===")
    unknown = dev.call("openapi_updateProject", {"project_name_or_id": "library"})
    check("an operation outside the allowlist is not callable",
          unknown["isError"] and "no such tool" in unknown["text"], unknown["text"][:80])

    bad = dev.call("openapi_getProject")
    check("a missing required argument is refused before any request",
          bad["isError"] and "invalid arguments" in bad["text"], bad["text"][:100])

    extra = dev.call("openapi_getProject", {"project_name_or_id": "library", "nope": 1})
    check("an unknown argument is refused", extra["isError"], extra["text"][:100])

    missing = dev.call("openapi_getProject", {"project_name_or_id": "does-not-exist-" + project})
    # Harbor answers 403, not 404, for a project you cannot see — it declines to
    # disclose whether one exists. So the assertion is about the behaviour that
    # matters (an upstream refusal becomes a tool error carrying the status)
    # rather than about a particular code.
    check("an upstream refusal surfaces as a tool error, not a crash",
          missing["isError"] and ("403" in missing["text"] or "404" in missing["text"]),
          missing["text"][:90])
    check("and it names the operation and the URL that failed",
          "GET" in missing["text"] and "/api/v2.0/projects/" in missing["text"], "")
    check("and it carries a hint the model can act on",
          "Hint:" in missing["text"], missing["text"].split("Hint:")[-1][:80].strip())

    print("\n=== 9. cleanup ===")
    if ok_created and not args.keep:
        removed = dev.call("openapi_deleteProject", {"project_name_or_id": project})
        check("the owner can delete their own project", not removed["isError"], removed["text"][:120])
        gone = dev.call("openapi_getProject", {"project_name_or_id": project})
        check("and it is gone", gone["isError"], gone["text"][:80])
    elif ok_created:
        note(f"--keep given; {project!r} left in place")

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
