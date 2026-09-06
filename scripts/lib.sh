# Shared settings and helpers. Sourced by every numbered script.
#
# One place defines the domain. Everything else - manifests included - spells it
# out literally so `kubectl apply -f deploy/...` works with no templating step.
# If you move the lab, change LAB_DOMAIN here and then:
#
#     grep -rl 192.168.1.200.nip.io .. | xargs sed -i "s/192.168.1.200.nip.io/$LAB_DOMAIN/g"
set -euo pipefail

LAB_DOMAIN="${LAB_DOMAIN:-192.168.1.200.nip.io}"
KEYCLOAK_URL="https://keycloak.${LAB_DOMAIN}"
HARBOR_URL="https://harbor.${LAB_DOMAIN}"
MCP_URL="https://mcp.${LAB_DOMAIN}"
REALM="lab"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Secrets come from lab.env, which is gitignored. Nothing tracked in this repo
# contains a usable credential; the manifests reference Kubernetes Secrets that
# the scripts build from these values.
if [ -f "$ROOT/lab.env" ]; then
  set -a; . "$ROOT/lab.env"; set +a
else
  printf "\n\033[1;31mx no lab.env\033[0m - run ./scripts/init-secrets.sh (or copy lab.env.example)\n" >&2
  exit 1
fi

for _v in KEYCLOAK_ADMIN_PASSWORD KEYCLOAK_DB_PASSWORD HARBOR_ADMIN_PASSWORD \
          HARBOR_OIDC_CLIENT_SECRET LAB_USER_DEV_PASSWORD LAB_USER_ALICE_PASSWORD; do
  [ -n "${!_v:-}" ] && [ "${!_v}" != "change-me" ] || {
    printf "\n\033[1;31mx %s is unset or still 'change-me' in lab.env\033[0m\n" "$_v" >&2; exit 1; }
done
unset _v
DEPLOY="$ROOT/deploy"

KUBECTL="${KUBECTL:-kubectl}"
HELM="${HELM:-helm}"
PYTHON="${PYTHON:-$(command -v python3 || command -v python)}"

step() { printf "\n\033[1;35m> %s\033[0m\n" "$*" >&2; }
die()  { printf "\n\033[1;31mx %s\033[0m\n" "$*" >&2; exit 1; }
ok()   { printf "\033[1;32mv %s\033[0m\n" "$*" >&2; }

need() { command -v "$1" >/dev/null 2>&1 || die "$1 not found on PATH"; }
