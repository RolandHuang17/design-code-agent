# Space Fractions — Vault reference configuration
#
# REFERENCE ONLY — NOT production-validated. Do not treat as a deployment
# guarantee. This file exists to document the secrets-management posture
# described in Architecture_Documentation.md §F (Secrets management & rotation
# policy) and the operator supplement's "reference" cloud configs requirement.
#
# It is an untested example: adjust storage backend, TLS, auth methods and
# policy rules for any real environment. No real secret values are defined.

# ---------------------------------------------------------------------------
# Storage backend (filesystem for local demonstration; use integrated storage
# or a hardened backend in production).
# ---------------------------------------------------------------------------
storage "file" {
  path = "/vault/file"
}

# ---------------------------------------------------------------------------
# Listener — TLS terminates here in production. The example disables TLS for
# purely local-only use; never disable TLS outside local development.
# ---------------------------------------------------------------------------
listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = "true" # LOCAL-ONLY. Production must enable TLS with cert/key.
}

# ---------------------------------------------------------------------------
# Seal configuration — auto-unseal example; replace with KMS/Hardware or
# shamir in production.
# ---------------------------------------------------------------------------
seal "shamir" {}

# ---------------------------------------------------------------------------
# Telemetry
# ---------------------------------------------------------------------------
telemetry {
  disable_hostname = true
}

# ---------------------------------------------------------------------------
# API/UI
# ---------------------------------------------------------------------------
api_addr = "http://127.0.0.1:8200"

ui = true

disable_mlock = true # LOCAL-ONLY. Production should set false.