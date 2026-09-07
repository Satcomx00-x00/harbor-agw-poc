#!/usr/bin/env bash
# The whole lab, in order. Re-runnable.
source "$(dirname "$0")/lib.sh"
cd "$(dirname "$0")"
./00-prereqs.sh
./10-keycloak.sh
./20-harbor.sh
./30-onboard.sh
./40-mcp.sh
./50-agentgateway.sh
./60-mcp-openapi.sh
step "smoke test: the auth chain"
"$PYTHON" ./smoke-test.py

step "end-to-end: mcp-openapi against the real Harbor"
"$PYTHON" ./test-openapi-e2e.py
