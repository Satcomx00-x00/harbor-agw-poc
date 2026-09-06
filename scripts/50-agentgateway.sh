#!/usr/bin/env bash
# agentgateway in front of mcp-harbor.
source "$(dirname "$0")/lib.sh"
need "$KUBECTL"

step "config"
$KUBECTL -n mcp create configmap agentgateway-config \
  --from-file=config.yaml="$DEPLOY/40-agentgateway/config.yaml" \
  --dry-run=client -o yaml | $KUBECTL apply -f -

step "deploy"
$KUBECTL apply -f "$DEPLOY/40-agentgateway/deployment.yaml"
CK=$(sha256sum "$DEPLOY/40-agentgateway/config.yaml" | cut -c1-12)
$KUBECTL -n mcp patch deploy agentgateway --type merge \
  -p "{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"lab.agentgateway/checksum\":\"$CK\"}}}}}"
$KUBECTL -n mcp rollout status deploy/agentgateway --timeout=300s
ok "agentgateway serving MCP at $MCP_URL/mcp"
