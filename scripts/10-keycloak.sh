#!/usr/bin/env bash
# Keycloak and the `lab` realm.
source "$(dirname "$0")/lib.sh"
need "$KUBECTL"

step "secrets (from lab.env, never from a tracked file)"
$KUBECTL -n keycloak create secret generic keycloak-db \
  --from-literal=POSTGRES_DB=keycloak \
  --from-literal=POSTGRES_USER=keycloak \
  --from-literal=POSTGRES_PASSWORD="$KEYCLOAK_DB_PASSWORD" \
  --dry-run=client -o yaml | $KUBECTL apply -f -

$KUBECTL -n keycloak create secret generic keycloak-admin \
  --from-literal=KC_BOOTSTRAP_ADMIN_USERNAME=admin \
  --from-literal=KC_BOOTSTRAP_ADMIN_PASSWORD="$KEYCLOAK_ADMIN_PASSWORD" \
  --dry-run=client -o yaml | $KUBECTL apply -f -

step "realm ConfigMap (placeholders filled from lab.env)"
# realm-lab.json is tracked with __PLACEHOLDER__ values so the repo carries no
# credential. Rendered here into a temp file that is removed straight after.
RENDERED="$(mktemp)"
trap 'rm -f "$RENDERED"' EXIT
sed -e "s|__HARBOR_OIDC_CLIENT_SECRET__|$HARBOR_OIDC_CLIENT_SECRET|g" \
    -e "s|__LAB_USER_DEV_PASSWORD__|$LAB_USER_DEV_PASSWORD|g" \
    -e "s|__LAB_USER_ALICE_PASSWORD__|$LAB_USER_ALICE_PASSWORD|g" \
    "$DEPLOY/10-keycloak/realm-lab.json" > "$RENDERED"
grep -q '__' "$RENDERED" && die "a placeholder was left unrendered in the realm"

$KUBECTL -n keycloak create configmap keycloak-realm \
  --from-file=lab-realm.json="$RENDERED" \
  --dry-run=client -o yaml | $KUBECTL apply -f -

step "postgres"
$KUBECTL apply -f "$DEPLOY/10-keycloak/postgres.yaml"
$KUBECTL -n keycloak rollout status statefulset/keycloak-db --timeout=300s

step "keycloak"
$KUBECTL apply -f "$DEPLOY/10-keycloak/keycloak.yaml"
# The realm is imported at start-up, so a realm edit has to restart the pod.
CK=$(sha256sum "$RENDERED" | cut -c1-12)
$KUBECTL -n keycloak patch deploy keycloak --type merge \
  -p "{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"lab.realm/checksum\":\"$CK\"}}}}}"
$KUBECTL -n keycloak rollout status deploy/keycloak --timeout=420s

step "verify the issuer answers"
curl -sk --retry 10 --retry-delay 3 --retry-all-errors \
  "$KEYCLOAK_URL/realms/$REALM/.well-known/openid-configuration" \
  | grep -q '"issuer"' || die "Keycloak discovery did not answer"
ok "keycloak ready at $KEYCLOAK_URL (realm $REALM)"
