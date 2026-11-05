# =============================================================================
# Space Fractions - AWS Infrastructure (Terraform) - Variables
# =============================================================================
# REFERENCE-ONLY CONFIGURATION
# -----------------------------------------------------------------------------
# This file is provided as an architectural reference example. It has NOT been
# validated against a live AWS environment and is not claimed to be
# production-validated. All values are example defaults; adjust before use.
# Sensitive values (passwords) intentionally have NO defaults and must be
# supplied via environment variables or a *.auto.tfvars file that is gitignored.
# =============================================================================

# -----------------------------------------------------------------------------
# General
# -----------------------------------------------------------------------------

variable "aws_region" {
  description = "AWS region where resources are provisioned."
  type        = string
  default     = "us-east-1"
}

# -----------------------------------------------------------------------------
# Networking
# -----------------------------------------------------------------------------

variable "vpc_cidr" {
  description = "CIDR block for the Space Fractions VPC."
  type        = string
  default     = "10.0.0.0/16"
}

variable "public_subnet_a" {
  description = "CIDR block for public subnet A (internet-facing load balancer)."
  type        = string
  default     = "10.0.1.0/24"
}

variable "public_subnet_b" {
  description = "CIDR block for public subnet B."
  type        = string
  default     = "10.0.2.0/24"
}

variable "private_subnet_a" {
  description = "CIDR block for private subnet A (app/database workloads)."
  type        = string
  default     = "10.0.11.0/24"
}

variable "private_subnet_b" {
  description = "CIDR block for private subnet B."
  type        = string
  default     = "10.0.12.0/24"
}

# -----------------------------------------------------------------------------
# Application / ECS
# -----------------------------------------------------------------------------

variable "gateway_image" {
  description = "Container image reference for the Space Fractions gateway."
  type        = string
  # Reference-only placeholder; set to an ECR repository URI in a real deployment.
  default = "spacefractions/gateway:latest"
}

variable "gateway_replicas" {
  description = "Desired number of gateway task replicas."
  type        = number
  default     = 3
}

# -----------------------------------------------------------------------------
# TLS / Load balancer
# -----------------------------------------------------------------------------

variable "tls_certificate_arn" {
  description = "ARN of the ACM TLS certificate to attach to the HTTPS listener."
  type        = string
  # No default: must be provided for the HTTPS listener to be valid.
}

# -----------------------------------------------------------------------------
# PostgreSQL (RDS)
# -----------------------------------------------------------------------------

variable "db_instance_class" {
  description = "RDS instance class for the PostgreSQL database."
  type        = string
  default     = "db.t3.small"
}

variable "db_name" {
  description = "Name of the application database."
  type        = string
  default     = "spacefractions"
}

variable "db_username" {
  description = "Master username for the RDS instance."
  type        = string
  default     = "spacefractions"
}

variable "db_password" {
  description = "Master password for the RDS instance. Supply via env var TF_VAR_db_password or a gitignored tfvars file."
  type        = string
  sensitive   = true
  # No default: must be provided. Do not commit credentials.
}