#!/usr/bin/env bash
# Create the Harbor user records that bearer-token auth requires.
#
# Harbor accepts an OIDC ID token on its API only for a user it already has a
# record for, and oidc_auto_onboard fires only in the browser callback. Skip
# this and every API call with a perfectly valid token returns 401, while
# harbor-core logs "oidc info for user ... not found".
source "$(dirname "$0")/lib.sh"

step "onboarding lab users into Harbor"
"$PYTHON" "$ROOT/scripts/onboard-harbor-user.py" --harbor "$HARBOR_URL" \
  --user dev   --password "$LAB_USER_DEV_PASSWORD"
"$PYTHON" "$ROOT/scripts/onboard-harbor-user.py" --harbor "$HARBOR_URL" \
  --user alice --password "$LAB_USER_ALICE_PASSWORD"
ok "users onboarded"
