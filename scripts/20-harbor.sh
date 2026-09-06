#!/usr/bin/env bash
# Harbor, then switch it to OIDC.
source "$(dirname "$0")/lib.sh"
need "$KUBECTL"; need "$HELM"

step "certificate"
$KUBECTL apply -f "$DEPLOY/20-harbor/certificate.yaml"

step "harbor"
# --set rather than a value in the file: values.yaml is tracked, lab.env is not.
$HELM upgrade --install harbor harbor --repo https://helm.goharbor.io --version 1.19.2 \
  -n harbor -f "$DEPLOY/20-harbor/values.yaml" \
  --set harborAdminPassword="$HARBOR_ADMIN_PASSWORD" --timeout 12m
$KUBECTL -n harbor rollout status deploy/harbor-core --timeout=600s

step "wait for the API"
for i in $(seq 1 60); do
  curl -sk -o /dev/null -u "admin:$HARBOR_ADMIN_PASSWORD" "$HARBOR_URL/api/v2.0/systeminfo" && break
  sleep 5
done

step "switch auth_mode to oidc_auth"
# Over the API rather than in the chart: the chart has no values for auth mode,
# and doing it here means a later `helm upgrade` cannot silently revert it.
#
# oidc_verify_cert is false because Harbor would otherwise need the lab CA in
# its own trust store; the chart can mount one via caBundleSecretName if you
# would rather do it properly.
code=$(curl -sk -o /dev/null -w "%{http_code}" -u "admin:$HARBOR_ADMIN_PASSWORD" \
  -X PUT "$HARBOR_URL/api/v2.0/configurations" -H "Content-Type: application/json" -d "{
    \"auth_mode\": \"oidc_auth\",
    \"oidc_name\": \"keycloak\",
    \"oidc_endpoint\": \"$KEYCLOAK_URL/realms/$REALM\",
    \"oidc_client_id\": \"harbor\",
    \"oidc_client_secret\": \"$HARBOR_OIDC_CLIENT_SECRET\",
    \"oidc_scope\": \"openid,profile,email,offline_access\",
    \"oidc_verify_cert\": false,
    \"oidc_auto_onboard\": true,
    \"oidc_user_claim\": \"preferred_username\"
  }")
[ "$code" = "200" ] || die "setting auth_mode returned HTTP $code (it can only change while admin is the only user)"
ok "harbor ready at $HARBOR_URL in oidc_auth mode"
