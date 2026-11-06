# ---------------------------------------------------------------------------
# Space Fractions — AWS Terraform example
#
# STATUS: REFERENCE-ONLY. NOT production-validated.
# This example sketches the infrastructure shape implied by section E
# "Operations & Deployment" of the original Architecture_Documentation.md and
# the operator supplement's request for an "AWS Terraform example". It is NOT
# the product of an `apply`, has NOT been validated against a live AWS account,
# and does NOT establish any availability, cost, security or backup guarantee.
#
# What it demonstrates (illustrative only):
#   * A VPC with public/private subnets for a multi-AZ posture.
#   * A managed Amazon RDS PostgreSQL instance (DB HA via Multi-AZ, echoing the
#     original "DB HA topology: PostgreSQL replication, regular backups").
#   * An ECR repository as the image destination for the spacefractions images.
#   * An EKS cluster as the target for the reference Kubernetes deployment in
#     ../k8s/spacefractions-deployment.yaml.
#
# Deviations / caveats when adapting to production:
#   * DB credentials below use `var.*`-sourced placeholders, never literals.
#     In a real deployment supply them via a secrets manager (e.g. AWS Secrets
#     Manager or Vault as sketched in ../reference/vault.hcl).
#   * TLS, service-mesh (../reference/istio.yaml), WAF, IAM least-privilege,
#     backup window/retention and RPO/RTO targets are deliberately omitted; do
#     not treat this file as a complete or reviewed production configuration.
#   * The original plan does not prescribe AWS specifically; any provider is
#     acceptable. AWS is used here purely as an example.
# ---------------------------------------------------------------------------

terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0" # illustrative pin; not validated for production
    }
  }

  # Reference-only: a real deployment should use a remote/encrypted backend.
  # backend "s3" { ... } is intentionally omitted.
}

# Region/availability zones come from variables so nothing is hard-coded.
variable "region" {
  description = "AWS region. Reference example; override per environment."
  type        = string
}

variable "az_count" {
  description = "Number of availability zones for the reference VPC."
  type        = number
  default     = 2
}

variable "db_username" {
  description = "RDS master username (supply via secrets manager in production)."
  type        = string
  sensitive   = true
}

variable "db_password" {
  description = "RDS master password (supply via secrets manager in production)."
  type        = string
  sensitive   = true
}

provider "aws" {
  # Reference-only: prefer an AssumeRole/provider alias to a locked-down role.
  region = var.region
}

# ---------------------------------------------------------------------------
# Networking (illustrative)
# ---------------------------------------------------------------------------
resource "aws_vpc" "spacefractions" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "spacefractions-vpc"
  }
}

resource "aws_subnet" "private" {
  count = var.az_count

  vpc_id            = aws_vpc.spacefractions.id
  cidr_block        = cidrsubnet(aws_vpc.spacefractions.cidr_block, 8, count.index)
  availability_zone = element(data.aws_availability_zones.available.names, count.index)

  tags = {
    Name = "spacefractions-private-${count.index}"
  }
}

resource "aws_subnet" "public" {
  count = var.az_count

  vpc_id                  = aws_vpc.spacefractions.id
  cidr_block              = cidrsubnet(aws_vpc.spacefractions.cidr_block, 8, var.az_count + count.index)
  availability_zone       = element(data.aws_availability_zones.available.names, count.index)
  map_public_ip_on_launch = true

  tags = {
    Name = "spacefractions-public-${count.index}"
  }
}

data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_db_subnet_group" "spacefractions" {
  name       = "spacefractions-db-subnet-group"
  subnet_ids = aws_subnet.private[*].id

  tags = {
    Name = "spacefractions-db-subnet-group"
  }
}

# ---------------------------------------------------------------------------
# PostgreSQL — system of record for all game state (RDS, Multi-AZ)
# ---------------------------------------------------------------------------
resource "aws_db_instance" "spacefractions" {
  identifier           = "spacefractions-postgres"
  engine               = "postgres"
  engine_version       = "16" # aligns with the supplement's PG16 constraint
  instance_class       = "db.t3.micro" # illustrative; rightsize for real load
  allocated_storage    = 20
  storage_encrypted    = true
  username             = var.db_username
  password             = var.db_password
  db_subnet_group_name = aws_db_subnet_group.spacefractions.name

  # DB HA topology (original: "PostgreSQL replication, regular backups").
  multi_az               = true
  backup_retention_period = 7 # illustrative; align to actual RPO/RTO targets
  skip_final_snapshot    = true # reference only; never skip in production

  vpc_security_group_ids = [aws_security_group.db.id]

  tags = {
    Name = "spacefractions-postgres"
  }
}

resource "aws_security_group" "db" {
  name        = "spacefractions-db-sg"
  description = "Reference security group for RDS (tighten for production)."
  vpc_id      = aws_vpc.spacefractions.id

  ingress {
    description = "PostgreSQL access from private subnets only."
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = aws_subnet.private[*].cidr_block
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# ---------------------------------------------------------------------------
# ECR — destination repository for the spacefractions images
# ---------------------------------------------------------------------------
resource "aws_ecr_repository" "spacefractions" {
  name                 = "spacefractions"
  image_tag_mutability = "MUTABLE" # illustrative; prefer IMMUTABLE for release tags

  image_scanning_configuration {
    scan_on_push = true
  }
}

# ---------------------------------------------------------------------------
# EKS — target cluster for the reference Kubernetes manifest
# ---------------------------------------------------------------------------
resource "aws_eks_cluster" "spacefractions" {
  name     = "spacefractions"
  role_arn = aws_iam_role.eks_cluster.arn

  vpc_config {
    subnet_ids = aws_subnet.public[*].id
  }

  depends_on = [aws_iam_role_policy_attachment.eks_cluster_policy]
}

resource "aws_iam_role" "eks_cluster" {
  name = "spacefractions-eks-cluster-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "eks.amazonaws.com"
      }
      Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "eks_cluster_policy" {
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"
  role       = aws_iam_role.eks_cluster.name
}

# ---------------------------------------------------------------------------
# Outputs (illustrative; help later modules reference resources)
# ---------------------------------------------------------------------------
output "db_endpoint" {
  description = "RDS PostgreSQL endpoint. Reference-only."
  value       = aws_db_instance.spacefractions.endpoint
}

output "ecr_repository_url" {
  description = "ECR repository URL for publishing images. Reference-only."
  value       = aws_ecr_repository.spacefractions.repository_url
}

output "eks_cluster_name" {
  description = "EKS cluster name for the reference deployment. Reference-only."
  value       = aws_eks_cluster.spacefractions.name
}