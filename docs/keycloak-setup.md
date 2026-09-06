# Keycloak setup for MCP → Harbor authentication

What has to exist in Keycloak for a tool call to reach Harbor as the human who
made it, why each piece is there, and how to tell which one is wrong when it
breaks.

`scripts/10-keycloak.sh` imports all of this from
[`deploy/10-keycloak/realm-lab.json`](../deploy/10-keycloak/realm-lab.json), so
you never have to do it by hand. This document is for when you need to
understand it, reproduce it on an existing Keycloak, or debug it.

---

## The one thing to understand first

Two systems validate the same token and they want **different `aud` claims**:

| validator | requires `aud` to contain | configured in |
|---|---|---|
| agentgateway | `mcp-gateway` | `deploy/40-agentgateway/config.yaml` |
| Harbor | `harbor` (its OIDC client id) | Harbor → Administration → Configuration → Authentication |

A token minted for one is rejected by the other. Everything below exists to
make **one token satisfy both**, using the fact that `aud` is a list.

Get this wrong and the symptom is misleading: the gateway returns a clean 401
and it looks like Keycloak is down, or Harbor returns 401 and it looks like the
gateway ate the token.

---

## 1. The realm

Create a realm named `lab`.

```
Realms → Create realm → Realm name: lab → Create
```

Then **Realm settings → General**:

| setting | value | why |
|---|---|---|
| Require SSL | `External requests` | TLS terminates at ingress-nginx; Keycloak itself speaks HTTP behind it |

The realm name is part of the issuer, and the issuer is compared as a literal
string by both validators:

```
https://keycloak.192.168.1.200.nip.io/realms/lab
```

If you rename the realm you must change `oidc_endpoint` in Harbor and `issuer`
in the gateway config to match. Nothing infers it.

---

## 2. Client `harbor` — the registry's own client

This one exists so Harbor can run the browser login flow. Its **client id is
also the audience value Harbor requires on API tokens**, which is what makes it
load-bearing for the MCP path even though the MCP never uses this client to
authenticate.

```
Clients → Create client
  Client type            OpenID Connect
  Client ID              harbor
  Name                   Harbor registry
```

Capability config:

| setting | value |
|---|---|
| Client authentication | **On** (confidential — Harbor holds the secret) |
| Standard flow | On |
| Direct access grants | Off |
| Service accounts roles | Off |

Access settings:

| setting | value |
|---|---|
| Valid redirect URIs | `https://harbor.192.168.1.200.nip.io/c/oidc/callback` |
| | `https://harbor.192.168.1.200.nip.io/*` |
| Web origins | `https://harbor.192.168.1.200.nip.io` |

Then **Credentials → Client secret** — copy it. It must be given to Harbor as
`oidc_client_secret`; a mismatch fails the code exchange with `invalid_client`,
*after* the user has already typed their password, which makes it look like a
credential problem rather than a configuration one.

In this repo both sides read `HARBOR_OIDC_CLIENT_SECRET` from `lab.env`.

### Optional client scopes

Leave `offline_access` available on this client. Harbor requests it
(`oidc_scope: openid,profile,email,offline_access`) so it can refresh the CLI
secret it hands to `docker login`. Without a refresh token that secret stops
working when the ID token expires.

---

## 3. Client `mcp` — what the MCP client authenticates as

```
Clients → Create client
  Client ID              mcp
  Name                   MCP client
```

| setting | value | why |
|---|---|---|
| Client authentication | **Off** (public) | an MCP client on a laptop cannot keep a secret |
| Standard flow | On | the real OAuth path, with PKCE |
| Direct access grants | On | password grant, so the smoke test can get a token without a browser |
| PKCE method | `S256` | mandatory for a public client |

Valid redirect URIs — the loopback entries are what an MCP client uses when it
opens a browser and listens on a random local port:

```
http://localhost:*
http://127.0.0.1:*
https://mcp.192.168.1.200.nip.io/*
```

> **Direct access grants in production.** It is on here so `smoke-test.py` can
> get a token in one HTTP call. A real deployment should turn it off and use the
> authorization-code flow only.

---

## 4. The audience mappers — the actual crux

On the **`mcp`** client (not the realm, not the `harbor` client):

```
Clients → mcp → Client scopes → mcp-dedicated → Add mapper → By configuration → Audience
```

### Mapper 1 — `audience-harbor`

| field | value |
|---|---|
| Name | `audience-harbor` |
| Included Client Audience | `harbor` |
| Add to ID token | **On** |
| Add to access token | On |

### Mapper 2 — `audience-mcp-gateway`

| field | value |
|---|---|
| Name | `audience-mcp-gateway` |
| Included **Custom** Audience | `mcp-gateway` |
| Add to ID token | **On** |
| Add to access token | On |

Two details that are easy to get wrong:

**Use *Custom* Audience for `mcp-gateway`.** "Included Client Audience" only
offers clients that exist. agentgateway is not a Keycloak client — it is a
resource server that validates tokens — so there is nothing to select. A custom
audience is a free string and is the correct choice.

**"Add to ID token" must be On.** This is the one that costs an afternoon.
Harbor's API authenticates with the **ID token**, not the access token. The
mapper defaults are not guaranteed to include the ID token, and a mapper that
only touches the access token produces a token that passes the gateway and is
then rejected by Harbor — with the gateway looking innocent, because it is.

---

## 5. Users

```
Users → Add user
  Username        dev
  Email           dev@lab.test
  Email verified  On
→ Credentials → Set password (Temporary: Off)
```

Repeat for `alice`. Two users is not decoration: it is the only way to prove
Harbor is resolving *each caller* rather than one shared account.

`Email verified` matters — Harbor's onboarding reads the profile, and an
unverified user can land in a verification flow instead of the callback.

---

## 6. What must match on the other side

Keycloak alone is not enough. Three values have to agree across three systems:

| value | Keycloak | Harbor | agentgateway |
|---|---|---|---|
| issuer | `https://keycloak.<domain>/realms/lab` | `oidc_endpoint` | `mcpAuthentication.issuer` |
| Harbor audience | `audience-harbor` mapper | `oidc_client_id: harbor` | — |
| gateway audience | `audience-mcp-gateway` mapper | — | `mcpAuthentication.audiences` |

Harbor's side, set by `scripts/20-harbor.sh`:

```json
{
  "auth_mode": "oidc_auth",
  "oidc_endpoint": "https://keycloak.192.168.1.200.nip.io/realms/lab",
  "oidc_client_id": "harbor",
  "oidc_scope": "openid,profile,email,offline_access",
  "oidc_user_claim": "preferred_username",
  "oidc_auto_onboard": true,
  "oidc_verify_cert": false
}
```

`auth_mode` can only be changed while `admin` is the **only** user in Harbor. On
an instance that already has users, this call fails and the message does not
say why.

---

## 7. Onboarding — the step Keycloak cannot do for you

Even with everything above correct, the first API call with a valid token
returns 401:

```
server/middleware/security/idtoken.go:53
failed to get user based on token claims: oidc info for user with issuer
https://keycloak.../realms/lab, subject 2e49dcd8-... not found
```

Harbor accepts a bearer ID token only for a user it already has a record for,
and `oidc_auto_onboard` fires **only in the browser callback**. A user who has
never opened the Harbor UI can never use the API.

Either log in once at `https://harbor.<domain>` and pick "LOGIN VIA OIDC
PROVIDER", or run:

```bash
./scripts/30-onboard.sh
```

which drives that flow headlessly. It is idempotent.

---

## 8. Verify

```bash
. ./lab.env
KC=https://keycloak.$LAB_DOMAIN

curl -sk -X POST "$KC/realms/lab/protocol/openid-connect/token" \
  -d grant_type=password -d client_id=mcp \
  -d username=dev -d password="$LAB_USER_DEV_PASSWORD" \
  -d 'scope=openid profile email' \
| python3 -c '
import json,sys,base64
d=json.load(sys.stdin)
p=d["id_token"].split(".")[1]; p+="="*(-len(p)%4)
c=json.loads(base64.urlsafe_b64decode(p))
print("iss :", c["iss"])
print("aud :", c["aud"])
print("user:", c["preferred_username"])'
```

Correct output — note `aud` is a **list of three**:

```
iss : https://keycloak.192.168.1.200.nip.io/realms/lab
aud : ['mcp', 'harbor', 'mcp-gateway']
user: dev
```

`mcp` is there because Keycloak always includes the requesting client. The other
two are your mappers. If either is missing, the mapper is on the wrong client or
"Add to ID token" is off.

Then the whole chain:

```bash
python3 scripts/smoke-test.py
```

---

## 9. When it breaks

| symptom | cause |
|---|---|
| `aud` has only `["mcp"]` | mappers are on the wrong client, or on a shared client scope the `mcp` client does not use |
| `aud` correct on the access token, missing on the ID token | "Add to ID token" is off — this is the common one |
| Gateway 401, `jwt validation failed` | `issuer` in the gateway config ≠ the `iss` claim, character for character |
| Gateway 401 with a token that decodes fine | `mcp-gateway` missing from `aud`, or `mcpAuthentication.audiences` names something else |
| Gateway OK, Harbor 401, log says `oidc info ... not found` | user never onboarded — run `scripts/30-onboard.sh` |
| Gateway OK, Harbor 401, log says token verification failed | `harbor` missing from `aud`, or Harbor's `oidc_client_id` is not `harbor` |
| Harbor login loops back to the login page | redirect URI mismatch, or `KC_PROXY_HEADERS` unset so Keycloak builds `http://` URLs |
| `invalid_client` after typing the password | Harbor's `oidc_client_secret` ≠ the `harbor` client's secret |
| Token works, then stops after ~30 min | expected; `accessTokenLifespan` is 1800s. Refresh, do not lengthen it |

Where to look:

```bash
kubectl -n harbor logs deploy/harbor-core | grep -i oidc
kubectl -n mcp logs deploy/agentgateway
kubectl -n keycloak logs deploy/keycloak
```

---

## 10. Reproducing without the console

Everything above is one JSON file. On any Keycloak:

```bash
# Render the placeholders, then import
sed -e "s|__HARBOR_OIDC_CLIENT_SECRET__|$HARBOR_OIDC_CLIENT_SECRET|g" \
    -e "s|__LAB_USER_DEV_PASSWORD__|$LAB_USER_DEV_PASSWORD|g" \
    -e "s|__LAB_USER_ALICE_PASSWORD__|$LAB_USER_ALICE_PASSWORD|g" \
    deploy/10-keycloak/realm-lab.json > /tmp/realm.json

kcadm.sh create realms -f /tmp/realm.json
```

The tracked file carries `__PLACEHOLDER__` values so the repository holds no
credential. `scripts/10-keycloak.sh` does the same rendering into a ConfigMap
that Keycloak imports with `--import-realm` at start-up, and refuses to proceed
if any placeholder survives.
