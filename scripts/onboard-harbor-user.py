#!/usr/bin/env python3
"""
Onboard a Keycloak user into Harbor by driving the OIDC browser flow headlessly.

Why this exists
---------------
Harbor's API accepts an OIDC ID token as a bearer credential, but only for a
user it already knows. The middleware verifies the token and then looks the
caller up by (issuer, subject):

    server/middleware/security/idtoken.go:53
    failed to get user based on token claims: oidc info for user with issuer
    https://keycloak.../realms/lab, subject 2e49dcd8-... not found

`oidc_auto_onboard` does *not* cover this path. Onboarding happens only in the
authorization-code callback — the browser flow — so a user who has never opened
the Harbor UI can never use the API, no matter how valid their token is.

This script performs that flow with an HTTP client instead of a browser:

    1. GET  /c/oidc/login          Harbor issues state + redirects to Keycloak
    2. GET  the Keycloak authorize URL, scrape the login form's action
    3. POST credentials to it      Keycloak redirects back with ?code=
    4. GET  /c/oidc/callback       Harbor exchanges the code and onboards

It is idempotent: running it for an already-onboarded user just logs them in.

Usage
-----
    . ../lab.env
    python3 onboard-harbor-user.py --user dev   --password "$LAB_USER_DEV_PASSWORD"
    python3 onboard-harbor-user.py --user alice --password "$LAB_USER_ALICE_PASSWORD"
"""

from __future__ import annotations

import argparse
import http.cookiejar
import re
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_HARBOR = "https://harbor.192.168.1.200.nip.io"


class Flow:
    def __init__(self, harbor: str, ca_file: str | None, insecure: bool) -> None:
        self.harbor = harbor.rstrip("/")
        if ca_file:
            # The honest option: verify against the lab CA, which
            # scripts/00-prereqs.sh writes to deploy/00-prereqs/lab-ca.crt.
            ctx = ssl.create_default_context(cafile=ca_file)
        else:
            ctx = ssl.create_default_context()
            if insecure:
                ctx.check_hostname = False
                ctx.verify_mode = ssl.CERT_NONE
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar),
            urllib.request.HTTPSHandler(context=ctx),
        )
        self.opener.addheaders = [("User-Agent", "harbor-onboard/1.0")]

    def get(self, url: str) -> tuple[str, str]:
        with self.opener.open(url, timeout=30) as r:
            return r.read().decode("utf-8", "replace"), r.geturl()

    def post(self, url: str, data: dict[str, str]) -> tuple[str, str]:
        body = urllib.parse.urlencode(data).encode()
        req = urllib.request.Request(
            url, data=body, headers={"Content-Type": "application/x-www-form-urlencoded"}
        )
        with self.opener.open(req, timeout=30) as r:
            return r.read().decode("utf-8", "replace"), r.geturl()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--harbor", default=DEFAULT_HARBOR)
    ap.add_argument("--user", required=True)
    ap.add_argument("--password", required=True)
    ap.add_argument("--ca-file", default=None,
                    help="verify TLS against this CA bundle, e.g. deploy/00-prereqs/lab-ca.crt")
    ap.add_argument("--insecure", action="store_true", default=True,
                    help="skip TLS verification (default when --ca-file is not given; the lab CA is private)")
    args = ap.parse_args()

    f = Flow(args.harbor, args.ca_file, args.insecure)

    # 1 + 2. Harbor redirects to Keycloak; urllib follows it, so what comes back
    # is already the Keycloak login page.
    try:
        html, final = f.get(f"{f.harbor}/c/oidc/login")
    except urllib.error.HTTPError as e:
        print(f"harbor /c/oidc/login failed: HTTP {e.code}", file=sys.stderr)
        return 1

    if "/realms/" not in final:
        print(f"expected to land on Keycloak, got {final}", file=sys.stderr)
        print("Is Harbor's auth_mode really oidc_auth?", file=sys.stderr)
        return 1

    # Keycloak's login page posts to a one-shot URL carrying session_code,
    # execution and tab_id. It must be scraped; it cannot be constructed.
    m = re.search(r'<form[^>]+id="kc-form-login"[^>]+action="([^"]+)"', html)
    if not m:
        m = re.search(r'<form[^>]+action="([^"]+)"[^>]*id="kc-form-login"', html)
    if not m:
        print("could not find the Keycloak login form on the page", file=sys.stderr)
        return 1

    action = m.group(1).replace("&amp;", "&")

    # 3 + 4. Posting credentials redirects to Harbor's callback, which urllib
    # follows, so this single call also completes the code exchange.
    try:
        _, final = f.post(action, {"username": args.user, "password": args.password})
    except urllib.error.HTTPError as e:
        print(f"login/callback failed: HTTP {e.code} at {e.url}", file=sys.stderr)
        return 1

    if "login" in final and "error" in final.lower():
        print(f"Keycloak rejected the credentials for {args.user}", file=sys.stderr)
        return 1

    # Confirm by asking Harbor who we are, using the session cookie just set.
    try:
        body, _ = f.get(f"{f.harbor}/api/v2.0/users/current")
    except urllib.error.HTTPError as e:
        print(f"onboarding did not take: /users/current returned {e.code}", file=sys.stderr)
        print(f"landed at: {final}", file=sys.stderr)
        return 1

    print(f"onboarded: {body}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
