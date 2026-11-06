# Space Fractions — Vault policy (REFERENCE-ONLY)
#
# Origin: Architecture_Documentation.md section E "Operations & Deployment"
# and the operator supplement (space-fractions.md lines 24-29).
#
# WARNING: This file is an unverified reference configuration. It has NOT been
# validated against a live Vault instance, is NOT production-ready, and makes
# no claim of security correctness or completeness. Review and harden before
# any real deployment. Only placeholder secret paths are defined here; no
# actual credentials or private keys are present.

# Allow each service to read only the secret material it needs, scoped to the
# "spacefractions" project path. Services receive the narrowest possible grants.
#
# NOTE: exact secret-engine mount and path layout are illustrative. Adjust to
# your Vault KV v2 mount (default: "secret") before use.

# --- Game service ----------------------------------------------------------
path "secret/data/spacefractions/game-service/*" {
  capabilities = ["read"]
}

path "secret/data/spacefractions/shared/rabbitmq/*" {
  capabilities = ["read"]
}

# --- Question service ------------------------------------------------------
path "secret/data/spacefractions/question-service/*" {
  capabilities = ["read"]
}

path "secret/data/spacefractions/shared/postgres/*" {
  capabilities = ["read"]
}

path "secret/data/spacefractions/shared/elasticsearch/*" {
  capabilities = ["read"]
}

# --- User service / OIDC ---------------------------------------------------
path "secret/data/spacefractions/user-service/*" {
  capabilities = ["read"]
}

# --- Admin service ---------------------------------------------------------
path "secret/data/spacefractions/admin-service/*" {
  capabilities = ["read"]
}

# --- Gateway ---------------------------------------------------------------
path "secret/data/spacefractions/gateway/*" {
  capabilities = ["read"]
}

path "secret/data/spacefractions/shared/redis/*" {
  capabilities = ["read"]
}

# --- Rotating the service credentials (per the rotation policy in the
# architecture) requires write access only for the designated operator token,
# never for long-lived service tokens. This block is intentionally granted to
# an operator role, not included in normal service policies. ----------------
path "sys/leases/revoke/spacefractions/*" {
  capabilities = ["update"]
}

# Deny access to everything else by default. Vault policies are default-deny;
# this block is redundant but kept explicit for readability in review.
path "*" {
  capabilities = ["deny"]
}