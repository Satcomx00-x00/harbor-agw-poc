# mcp-harbor-lab

A testbed where an MCP tool call reaches a Docker registry **as the human who
made it**, not as a shared service account.

Four moving parts on the `cluster-dev-1` Talos cluster:

| | | |
|---|---|---|
| **Keycloak** | `https://keycloak.192.168.1.200.nip.io` | issues the identity |
| **Harbor** | `https://harbor.192.168.1.200.nip.io` | the registry, in `oidc_auth` mode |
| **agentgateway** | `https://mcp.192.168.1.200.nip.io/mcp` | validates the JWT, forwards it |
| **mcp-harbor** | in-cluster | hand-written MCP server, no credentials of its own |
| **mcp-openapi** | in-cluster | the same, generated from an OpenAPI document + an allowlist |

```
MCP client ──token──▶ agentgateway ──same token──▶ mcp-harbor ──same token──▶ Harbor
                      validates aud                 holds no                  resolves the
                      ∋ mcp-gateway                 credentials               user from aud
                                                                              ∋ harbor
```

One token satisfies both validators because the Keycloak realm gives it two
audiences. That, and the reason Harbor still says 401 the first time, are in
**[docs/auth-flow.md](docs/auth-flow.md)** — read that before changing anything
about the token.

For what to configure in Keycloak, click by click, and what each failure mode
looks like: **[docs/keycloak-setup.md](docs/keycloak-setup.md)**.

---

## Layout

```
mcp-harbor/              hand-written MCP server for Harbor
  src/index.ts           stateless transport; the token lives one request
  src/harbor.ts          Harbor API client, bound to one caller's token
  src/tools.ts           seven read-only tools
mcp-openapi/             template MCP server: any OpenAPI document + an allowlist
  src/spec.ts            loads the document, builds the client from it
  src/allowlist.ts       the file that decides the exposed surface
  examples/              allowlists for Harbor and for an unauthenticated API
deploy/
  00-prereqs/            storage, ingress, cert-manager, the lab CA
  10-keycloak/           Keycloak + postgres + the `lab` realm
  20-harbor/             Harbor helm values + its certificate
  30-mcp-harbor/         the MCP deployment
  40-agentgateway/       gateway config (validated against the published schema)
docs/
  auth-flow.md           how one token crosses four systems
  keycloak-setup.md      what to configure in Keycloak, and why
  openapi-mcp.md         the template server: allowlist, auth modes, limits
  code-quality.md        the tooling, what it found, and the patterns applied
scripts/
  init-secrets.sh        generates lab.env
  bootstrap.sh           all of it, in order, re-runnable
  smoke-test.py          proves the identity actually crosses all four systems
  onboard-harbor-user.py the step Harbor forces on you (see auth-flow.md)
lab.env.example          every secret the lab needs; copy to lab.env
```

## Secrets

Nothing tracked in this repository is a usable credential. Passwords and the
OIDC client secret live in `lab.env`, which is gitignored; the manifests
reference Kubernetes Secrets that the scripts build from it, and
`deploy/10-keycloak/realm-lab.json` carries `__PLACEHOLDER__` values that
`scripts/10-keycloak.sh` renders at install time (and refuses to proceed if any
survive).

```bash
./scripts/init-secrets.sh      # random values
# or
cp lab.env.example lab.env     # and edit
```

Losing `lab.env` means reinstalling: Keycloak's copy of the client secret and
Harbor's have to stay equal, and neither can be read back out.

## Checks

```bash
npm install        # repo-level tooling only; each MCP package installs its own
npm run check      # typecheck + eslint + knip + tests
```

139 tests in about a second, 91% line coverage, and the lint runs
type-aware. What the tooling found the first time it was pointed at this code —
including two real defects and one design decision that had to be re-argued — is
in [docs/code-quality.md](docs/code-quality.md).

## Prerequisites

- `kubectl`, `helm`, `npm`, `python3` on PATH
- a `KUBECONFIG` pointing at a cluster with at least ~6 GiB free
- outbound DNS, because the hostnames are `*.nip.io`
- a `lab.env` (see **Secrets** above)

## Run it

```bash
./scripts/init-secrets.sh
./scripts/bootstrap.sh
```

Roughly 10 minutes cold, most of it Harbor. Then:

```bash
python3 scripts/smoke-test.py
```

Expected tail:

```
[  ok  ] Harbor sees the caller as 'dev'  — got 'dev'
[  ok  ] Harbor sees the second caller as 'alice'  — got 'alice'
[  ok  ] the two callers are distinct identities  — 3 vs 4
all checks passed
```

## Try it by hand

```bash
. ./lab.env
KC=https://keycloak.$LAB_DOMAIN
TOKEN=$(curl -sk -X POST "$KC/realms/lab/protocol/openid-connect/token" \
  -d grant_type=password -d client_id=mcp \
  -d username=dev -d password="$LAB_USER_DEV_PASSWORD" \
  -d 'scope=openid profile email' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id_token"])')

# agentgateway is stateful: initialize first, keep the Mcp-Session-Id.
curl -sk -X POST https://mcp.192.168.1.200.nip.io/mcp -D- \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
        "protocolVersion":"2025-06-18","capabilities":{},
        "clientInfo":{"name":"curl","version":"1"}}}'
```

Drop the `Authorization` header and you get a 401 from the gateway — the MCP
server is never reached.

To trust the lab CA instead of using `-k`:

```bash
curl --cacert deploy/00-prereqs/lab-ca.crt https://harbor.192.168.1.200.nip.io/api/v2.0/systeminfo
```

### Logins

| where | user | password |
|---|---|---|
| Keycloak admin | `admin` | `KEYCLOAK_ADMIN_PASSWORD` |
| realm `lab` | `dev` / `alice` | `LAB_USER_DEV_PASSWORD` / `LAB_USER_ALICE_PASSWORD` |
| Harbor local admin | `admin` | `HARBOR_ADMIN_PASSWORD` |

All from `lab.env`. Harbor's local `admin` still works for the API after the
switch to OIDC — deliberately: it is how `20-harbor.sh` configures OIDC in the
first place, and the way back in when OIDC breaks.

## Tools

Two servers are multiplexed behind one MCP endpoint, in two namespaces.

`harbor_*` — hand-written (`mcp-harbor/`). `harbor_whoami` is the useful one: it
distinguishes "the token never arrived" from "the token arrived and this user
lacks access", which is otherwise a long afternoon.

`openapi_*` — generated (`mcp-openapi/`) from Harbor's own OpenAPI document,
restricted by `mcp-openapi/examples/harbor.allowlist.txt`. Point it at a
different document and it serves a different API with no code change. See
[docs/openapi-mcp.md](docs/openapi-mcp.md).

Both receive the same forwarded token, so both resolve to the same Harbor user.

## Known rough edges

**The MCP server does not run from a built image.** `deploy/30-mcp-harbor`
runs stock `node:22-alpine`, takes the compiled `dist/` from a ConfigMap and
`npm ci`s at pod start. The Dockerfile in `mcp-harbor/` is real and correct, but
using it needs two things this lab does not have yet: a builder, and — because
Harbor serves a certificate from the private lab CA — a Talos machine-config
change so containerd will pull from it (`machine.registries.config`, which is a
patch in `proxmox-config/infra/terraform-talos/locals.tf`, not a Kubernetes
change). Both are worth doing; neither is needed for the identity chain.

**Trivy is off** (`deploy/20-harbor/values.yaml`), so
`harbor_get_artifact`'s scan overview is always empty. It pulls a large
vulnerability DB and keeps a process resident; turn it on when you want scans.

**`oidc_verify_cert: false`** on the Harbor side, so Harbor does not need the
lab CA to talk to Keycloak. The Harbor chart can mount one via
`caBundleSecretName` if you would rather do it properly. Note this is Harbor →
Keycloak only; mcp-harbor → Harbor *does* verify, via `NODE_EXTRA_CA_CERTS`.

**The realm is imported, not reconciled.** Editing a client in the Keycloak
console works, and the next `10-keycloak.sh` will not undo it — `--import-realm`
skips a realm that already exists. To re-import, delete the realm first. The
console and `realm-lab.json` can therefore drift; the file is the source of
truth only for a fresh install.

**Two audiences means one blast radius.** A token good for the gateway is also
good against Harbor directly. That is the design — it is what makes the identity
chain work without a second credential — but it does mean the gateway is not a
choke point for Harbor access, only for MCP access.

## Moving the lab

Every hostname is spelled out literally in the manifests, so
`kubectl apply -f deploy/...` works with no templating step. To relocate:

```bash
grep -rl 192.168.1.200.nip.io . | xargs sed -i 's/192.168.1.200.nip.io/NEW.DOMAIN/g'
```

Then re-run `scripts/bootstrap.sh`. The Keycloak redirect URIs, Harbor's
`externalURL` and the gateway's `issuer` all follow from that one string.

## Tearing it down

```bash
helm uninstall harbor -n harbor
helm uninstall ingress-nginx -n ingress-nginx
helm uninstall cert-manager -n cert-manager
kubectl delete ns mcp keycloak harbor local-path-storage
```

PVCs go with the namespaces; the directories under `/var/local-path-provisioner`
on the node do not, and are yours to remove.
