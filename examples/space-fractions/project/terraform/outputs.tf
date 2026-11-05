# =============================================================================
# Space Fractions - AWS Infrastructure (Terraform) - Outputs
# =============================================================================
# REFERENCE-ONLY CONFIGURATION
# -----------------------------------------------------------------------------
# This file is provided as an architectural reference example. It has NOT been
# validated against a live AWS environment and is not claimed to be
# production-validated. Outputs surface identifiers/endpoints useful for CI and
# downstream tooling. Sensitive values (RDS master password) are intentionally
# NOT emitted here; they remain only in Terraform state / a secrets manager.
# =============================================================================

# -----------------------------------------------------------------------------
# Networking
# -----------------------------------------------------------------------------

output "vpc_id" {
  description = "ID of the Space Fractions VPC."
  value       = aws_vpc.main.id
}

output "public_subnet_ids" {
  description = "IDs of the public subnets (used by the internet-facing ALB)."
  value       = [aws_subnet.public_a.id, aws_subnet.public_b.id]
}

output "private_subnet_ids" {
  description = "IDs of the private subnets (used by ECS tasks and RDS)."
  value       = [aws_subnet.private_a.id, aws_subnet.private_b.id]
}

# -----------------------------------------------------------------------------
# Application endpoint
# -----------------------------------------------------------------------------

output "alb_dns_name" {
  description = "Public DNS name of the Space Fractions application load balancer."
  value       = aws_lb.main.dns_name
}

output "gateway_https_url" {
  description = "Base HTTPS URL for the Space Fractions browser UI and API gateway."
  value       = "https://${aws_lb.main.dns_name}"
}

# -----------------------------------------------------------------------------
# ECS
# -----------------------------------------------------------------------------

output "ecs_cluster_name" {
  description = "Name of the ECS cluster hosting the Space Fractions microservices."
  value       = aws_ecs_cluster.main.name
}

# -----------------------------------------------------------------------------
# PostgreSQL (RDS)
# -----------------------------------------------------------------------------

output "db_endpoint" {
  description = "Connection endpoint (host:port) of the RDS PostgreSQL instance."
  value       = aws_db_instance.postgres.endpoint
}

output "db_name" {
  description = "Application database name on the RDS instance."
  value       = aws_db_instance.postgres.db_name
}

output "db_username" {
  description = "Master username for the RDS instance."
  value       = aws_db_instance.postgres.username
}

output "db_identifier" {
  description = "Identifier of the RDS PostgreSQL instance."
  value       = aws_db_instance.postgres.identifier
}

# -----------------------------------------------------------------------------
# ElastiCache (Redis)
# -----------------------------------------------------------------------------

output "redis_endpoint" {
  description = "Primary endpoint address of the ElastiCache Redis cluster (port implied: 6379)."
  value       = aws_elasticache_cluster.redis.cache_nodes[0].address
}

output "redis_cluster_id" {
  description = "Cluster identifier of the ElastiCache Redis cluster."
  value       = aws_elasticache_cluster.redis.cluster_id
}