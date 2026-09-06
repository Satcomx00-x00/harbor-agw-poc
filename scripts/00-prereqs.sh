#!/usr/bin/env bash
# Storage, ingress and TLS - everything the application layers assume exists.
source "$(dirname "$0")/lib.sh"
need "$KUBECTL"; need "$HELM"

step "namespaces (PodSecurity relaxed where Talos would otherwise refuse the pods)"
$KUBECTL apply -f "$DEPLOY/00-prereqs/namespaces.yaml"

step "local-path-provisioner (becomes the default StorageClass)"
# Vendored and patched: upstream writes into /opt, which is read-only on Talos.
$KUBECTL apply -f "$DEPLOY/00-prereqs/local-path-provisioner.yaml"
$KUBECTL -n local-path-storage rollout status deploy/local-path-provisioner --timeout=180s

step "ingress-nginx (hostNetwork; this cluster has no load balancer)"
$HELM upgrade --install ingress-nginx ingress-nginx \
  --repo https://kubernetes.github.io/ingress-nginx --version 4.15.1 \
  -n ingress-nginx -f "$DEPLOY/00-prereqs/ingress-nginx.values.yaml" --wait --timeout 8m

step "cert-manager"
$HELM upgrade --install cert-manager cert-manager \
  --repo https://charts.jetstack.io --version v1.21.1 \
  -n cert-manager --set crds.enabled=true --wait --timeout 8m

step "lab CA and ClusterIssuer"
$KUBECTL apply -f "$DEPLOY/00-prereqs/ca-issuer.yaml"
$KUBECTL -n cert-manager wait --for=condition=Ready certificate/lab-ca --timeout=120s

step "export the CA so clients and workloads can trust it"
$KUBECTL -n cert-manager get secret lab-ca-tls -o jsonpath="{.data.ca\.crt}" \
  | base64 -d > "$DEPLOY/00-prereqs/lab-ca.crt"
for ns in mcp harbor; do
  $KUBECTL -n "$ns" create configmap lab-ca \
    --from-file=ca.crt="$DEPLOY/00-prereqs/lab-ca.crt" \
    --dry-run=client -o yaml | $KUBECTL apply -f -
done
ok "prereqs ready - CA written to $DEPLOY/00-prereqs/lab-ca.crt"
