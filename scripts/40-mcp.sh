#!/usr/bin/env bash
# Build mcp-harbor and ship it to the cluster.
source "$(dirname "$0")/lib.sh"
need "$KUBECTL"; need npm

step "compile"
cd "$ROOT/mcp-harbor"
npm ci --no-audit --no-fund
npm run build

step "ship dist/ as a ConfigMap"
# ConfigMap keys cannot contain a slash, so dist/ arrives flat and the pod's
# init container rebuilds the directory. See deploy/30-mcp-harbor/deployment.yaml.
$KUBECTL -n mcp create configmap mcp-harbor-src \
  --from-file=package.json --from-file=package-lock.json \
  --from-file=dist/index.js --from-file=dist/config.js \
  --from-file=dist/harbor.js --from-file=dist/tools.js \
  --dry-run=client -o yaml | $KUBECTL apply -f -

step "deploy"
$KUBECTL apply -f "$DEPLOY/30-mcp-harbor/deployment.yaml"
CK=$(cat dist/*.js package.json | sha256sum | cut -c1-12)
$KUBECTL -n mcp patch deploy mcp-harbor --type merge \
  -p "{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"lab.mcp/checksum\":\"$CK\"}}}}}"
$KUBECTL -n mcp rollout status deploy/mcp-harbor --timeout=300s
ok "mcp-harbor running"
