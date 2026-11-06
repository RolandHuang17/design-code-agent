# =============================================================================
# Space Fractions — AWS Terraform example
# STATUS: REFERENCE-ONLY — NOT production-validated.
#
# This Terraform example is generated from the architecture documentation for
# illustration purposes only. It has NOT been planned/applied against a live
# AWS account, and no availability, security, or cost validation is claimed.
# All credentials/identifiers are placeholders and must be supplied from a
# secret manager / remote state backend before any real deployment.
#
# Reference sources:
#   - Architecture_Documentation.md (Operations & Deployment, lines 130-156)
#   - space-fractions.md (reference-only configs, lines 24-29)
#
# Note: this file intentionally demonstrates the *shape* of an AWS deployment
# (VPC, RDS PostgreSQL, EKS) described by the architecture. It is NOT an
# authoritative or tested production configuration.
# =============================================================================

terraform {
  # Pin providers; do NOT rely on floating "latest" provider versions.
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  backend "s3" {
    # Reference-only placeholders. Replace with a real, restricted bucket and
    # enable state locking via DynamoDB. State may contain secrets; use
    # encryption and least-privilege IAM.
    bucket         = "spacefractions-tfstate-PLACEHOLDER"
    key            = "spacefractions/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "spacefractions-tfstate-lock-PLACEHOLDER"
  }
}

# --- Provider configuration (placeholders only) -----------------------------
provider "aws" {
  region = "us-east-1"
  # Credentials must be injected via standard AWS provider environment
  # variables / IAM roles; never hard-code access keys here.
}

# --- Networking -------------------------------------------------------------
resource "aws_vpc" "main" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name    = "spacefractions-vpc"
    Purpose = "reference-only"
  }
}

resource "aws_subnet" "private" {
  count = 2

  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.${count.index}.0/24"
  availability_zone = "us-east-1a"

  tags = {
    Name    = "spacefractions-private-${count.index}"
    Purpose = "reference-only"
  }
}

# --- PostgreSQL (source of truth for game state) ----------------------------
# The design requires PostgreSQL to own all game state (space-fractions.md
# lines 47-50). This is a reference-only RDS shape; no multi-AZ HA claim is
# made here beyond the architecture's DB HA topology discussion.
resource "aws_db_instance" "spacefractions" {
  identifier     = "spacefractions-postgres"
  engine         = "postgres"
  engine_version = "16"

  instance_class    = "db.t3.micro" # reference-only sizing
  allocated_storage = 20

  # Credentials are placeholders. In production, fetch from a secret manager.
  username = "spacefractions"
  password = "PLACEHOLDER-CHANGE-ME"

  db_name                 = "spacefractions"
  skip_final_snapshot     = true
  backup_retention_period = 7

  vpc_security_group_ids = [aws_security_group.db.id]
  db_subnet_group_name   = aws_db_subnet_group.main.name

  tags = {
    Name    = "spacefractions-postgres"
    Purpose = "reference-only"
  }
}

resource "aws_db_subnet_group" "main" {
  name       = "spacefractions-subnet-group"
  subnet_ids = aws_subnet.private[*].id

  tags = {
    Purpose = "reference-only"
  }
}

resource "aws_security_group" "db" {
  name        = "spacefractions-db-sg"
  description = "PostgreSQL access (reference-only)"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = ["10.0.0.0/16"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Purpose = "reference-only"
  }
}

# --- EKS control plane (Kubernetes-ready plan, lines 131-152) ---------------
resource "aws_eks_cluster" "main" {
  name     = "spacefractions-eks"
  role_arn = aws_iam_role.eks_cluster.arn

  vpc_config {
    subnet_ids = aws_subnet.private[*].id
  }

  tags = {
    Name    = "spacefractions-eks"
    Purpose = "reference-only"
  }
}

resource "aws_iam_role" "eks_cluster" {
  name = "spacefractions-eks-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "eks.amazonaws.com"
      }
    }]
  })

  tags = {
    Purpose = "reference-only"
  }
}

# --- Outputs -----------------------------------------------------------------
output "db_endpoint" {
  description = "PostgreSQL endpoint (reference-only)"
  value       = aws_db_instance.spacefractions.endpoint
}

output "eks_cluster_name" {
  description = "EKS cluster name (reference-only)"
  value       = aws_eks_cluster.main.name
}