# =============================================================================
# Vault server configuration for the Space Fractions system.
#
# STATUS: REFERENCE-ONLY CONFIGURATION.
# This configuration has NOT been validated against a live Vault cluster. It is
# provided as a starting point for the secret backend used by Space Fractions
# and must be reviewed, tested, and approved by the security team before use in
# production. This file is a server `.hcl` config (not a policy); the matching
# access-control policy lives in `vault/vault-policy.hcl`.
#
# Intended use
# ------------
# Vault is the secrets manager referenced by AD-015 (secrets management &
# rotation policy). Services obtain database, cache, messaging, search, and
# OIDC credentials from a KV v2 secrets engine mounted at `secret/`, organized
# under `spacefractions/`. In production this file would be mounted into the
# Vault server container / pod and referenced by the `vault server -config=...`
# command. TLS certificates, storage backend access, and unseal keys MUST be
# provided out-of-band (never committed to source control).
#
# Secrets paths (KV v2, mounted at `secret/`)
#   secret/spacefractions/database      postgres credentials
#   secret/spacefractions/redis         redis password
#   secret/spacefractions/rabbitmq      amqp credentials
#   secret/spacefractions/elasticsearch elasticsearch credentials
#   secret/spacefractions/oidc          keycloak client secret / issuer
#
# Authentication
# --------------
# The reference deployment enables Kubernetes auth (path `kubernetes/`) so that
# service accounts can mint scoped Vault tokens. The Kubernetes cluster its
# `kubernetes_host` (JWT issuer) and the expected service-account audience must
# be filled in by the operator. Token auth is left disabled here by default.
#
# Sealing / unsealing
# -------------------
# Vault starts unsealed only if an operator supplies an unseal key share; this
# file deliberately does not. Operators should use Shamir key shares (default)
# or a cloud KMS auto-unseal seal stanza (see commented example below).
# =============================================================================

# ---------------------------------------------------------------------------
# Listener: TLS is assumed to terminate at Vault. UNVERIFIED: the operator must
# supply a private key/certificate via Vault's standard tls_cert_file /
# tls_key_file arguments (Vault terminates its own TLS unless fronted by a
# load balancer). The `tls_disable = 0` default is made explicit here.
# ---------------------------------------------------------------------------
listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = 0
}

# ---------------------------------------------------------------------------
# Storage backend.
#
# REFERENCE-ONLY: `inmem` is for local development ONLY and loses all data on
# restart. For any durable deployment use a backed store; see the commented
# `raft` stanza below (recommended) or `consul`/`postgresql`. The backend block
# is intentionally left generic so the operator can select per environment.
# ---------------------------------------------------------------------------
storage "inmem" {
  # Development only. NOT durable. Replace before any non-local use.
}

# --- Recommended durable storage (commented out; uncomment and configure) ----
# storage "raft" {
#   path    = "/vault/data"
#   node_id = "vault-1"
#
#   retry_join {
#     leader_api_addr = "https://vault-1:8200"
#   }
# }

# ---------------------------------------------------------------------------
# Seal: Shamir key shares (default). UNVERIFIED: unseal shares must be
# distributed to operators out-of-band. For cloud deployments, replace with a
# KMS auto-unseal `seal` stanza appropriate to the target cloud.
# ---------------------------------------------------------------------------
# seal "awskms" {
#   region     = "us-east-1"
#   kms_key_id = "CHANGE_ME"
# }

# ---------------------------------------------------------------------------
# Telemetry: expose Prometheus-style metrics. Matches the Prometheus 2 stack
# referenced in the architecture and the scrape config in prometheus/prometheus.yml.
# ---------------------------------------------------------------------------
telemetry {
  disable_hostname = true
  prometheus_retention_time = "30s"
}

# ---------------------------------------------------------------------------
# API / cluster address advertisement. Used for the Kubernetes auth method's
# JWT issuer validation and for clients to reach the cluster. UNVERIFIED for a
# specific domain; set to the load-balancer or Ingress hostname in production.
# ---------------------------------------------------------------------------
api_addr = "https://127.0.0.1:8200"
cluster_addr = "https://127.0.0.1:8201"

# ---------------------------------------------------------------------------
# Default TTLs / max TTLs for tokens and leases. Values are conservative and
# may be tuned by the security team. Not production-validated.
# ---------------------------------------------------------------------------
default_lease_ttl = "1h"
max_lease_ttl     = "24h"

# ---------------------------------------------------------------------------
# UI / raw storage endpoints. UI is enabled for operator convenience in the
# reference environment; consider disabling in locked-down production.
# ---------------------------------------------------------------------------
ui = true
# disable_mlock is NOT set: Vault defaults to mlock, which requires the
# container to drop the CAP_IPC_LOCK limitation (e.g. via
# securityContext.capabilities.add: ["IPC_LOCK"]) or Vault may log a warning.