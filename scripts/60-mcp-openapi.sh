#!/usr/bin/env bash
# Build mcp-openapi and ship it, then reload the gateway.
#
# Order is load-bearing: agentgateway reads each target's tool list when it
# initialises, so restarting it before this backend is serving caches the old
# list. That is why the gateway restart lives here rather than in 50-*.sh.
source "$(dirname "$0")/lib.sh"
need "$KUBECTL"; need npm

step "compile"
cd "$ROOT/mcp-openapi"
npm ci --no-audit --no-fund
npm run build

step "ship dist/ and the allowlist"
$KUBECTL -n mcp create configmap mcp-openapi-src \
  --from-file=package.json --from-file=package-lock.json \
  --from-file=dist/index.js --from-file=dist/config.js --from-file=dist/spec.js \
  --from-file=dist/allowlist.js --from-file=dist/client.js \
  --dry-run=client -o yaml | $KUBECTL apply -f -

# The allowlist is the access-control surface, so it is mounted as its own
# ConfigMap rather than baked into the image: changing what is exposed should
# not require a rebuild.
$KUBECTL -n mcp create configmap mcp-openapi-allowlist \
  --from-file=allowlist.txt="${MCP_OPENAPI_ALLOWLIST:-$ROOT/mcp-openapi/examples/harbor.allowlist.txt}" \
  --dry-run=client -o yaml | $KUBECTL apply -f -

step "deploy"
$KUBECTL apply -f "$DEPLOY/50-mcp-openapi/deployment.yaml"
CK=$(cat dist/*.js examples/harbor.allowlist.txt | sha256sum | cut -c1-12)
$KUBECTL -n mcp patch deploy mcp-openapi --type merge \
  -p "{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"lab.mcp-openapi/checksum\":\"$CK\"}}}}}"
$KUBECTL -n mcp rollout status deploy/mcp-openapi --timeout=300s

step "reload agentgateway so it re-reads both targets' tools"
$KUBECTL -n mcp rollout restart deploy/agentgateway
$KUBECTL -n mcp rollout status deploy/agentgateway --timeout=300s
ok "mcp-openapi running; tools served at $MCP_URL/mcp"
