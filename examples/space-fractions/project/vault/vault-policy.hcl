# =============================================================================
# Vault policy for the Space Fractions system.
#
# STATUS: REFERENCE-ONLY CONFIGURATION.
# This policy has NOT been validated against a live Vault cluster. It is
# provided as a starting point for secret access control and must be reviewed,
# tested, and approved by the security team before use in production.
#
# Secrets used by Space Fractions (paths under the `spacefractions/` KV v2
# mount). Each service mounts its own namespace under `secret/`:
#   secret/spacefractions/database        (postgres credentials)
#   secret/spacefractions/redis           (redis password)
#   secret/spacefractions/rabbitmq        (amqp credentials)
#   secret/spacefractions/elasticsearch   (elasticsearch credentials)
#   secret/spacefractions/oidc            (keycloak client secret / issuer)
#
# The application reads these via the vault-agent sidecar or a Vault token
# supplied through Kubernetes auth. Rotation is handled out-of-band by the
# security team per AD-015 (secrets rotation policy).
# =============================================================================

# --- Application service policy (attached to the `spacefractions-app` role) ---
path "secret/data/spacefractions/database" {
  capabilities = ["read"]
}

path "secret/data/spacefractions/redis" {
  capabilities = ["read"]
}

path "secret/data/spacefractions/rabbitmq" {
  capabilities = ["read"]
}

path "secret/data/spacefractions/elasticsearch" {
  capabilities = ["read"]
}

path "secret/data/spacefractions/oidc" {
  capabilities = ["read"]
}

# Applications must never read other tenants' secrets.
path "secret/data/spacefractions/*" {
  capabilities = ["read"]
}

# Deny everything else by default (least privilege).
path "*" {
  capabilities = ["deny"]
}