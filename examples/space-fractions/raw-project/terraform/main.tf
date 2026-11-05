# =============================================================================
# Space Fractions - AWS Infrastructure (Terraform)
# =============================================================================
# REFERENCE-ONLY CONFIGURATION
# -----------------------------------------------------------------------------
# This file is provided as an architectural reference example for how the Space
# Fractions system could be provisioned on AWS. It has NOT been validated
# against a live AWS environment and is not claimed to be production-validated.
# Review and adjust before use (network ranges, instance types, region, tags,
# IAM policies, secrets, and domain names).
#
# Requirements: terraform ~> 1.0 (pinned by caller; we declare >= 1.0 here but
# no `latest` semantics). Provider hashicorp/aws pinned via required_providers.
# =============================================================================

terraform {
  required_version = ">= 1.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 4.0, < 6.0"
    }
  }

  backend "s3" {
    # Override these values or use a `-backend-config` file in CI.
    # Never hardcode credentials here.
    bucket         = "space-fractions-tfstate-example"
    key            = "spacefractions/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "space-fractions-tfstate-lock"
  }
}

provider "aws" {
  region = var.aws_region
}

# -----------------------------------------------------------------------------
# Networking
# -----------------------------------------------------------------------------

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "spacefractions-vpc"
  }
}

resource "aws_subnet" "public_a" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = var.public_subnet_a
  availability_zone       = "${var.aws_region}a"
  map_public_ip_on_launch = true

  tags = { Name = "spacefractions-public-a" }
}

resource "aws_subnet" "public_b" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = var.public_subnet_b
  availability_zone       = "${var.aws_region}b"
  map_public_ip_on_launch = true

  tags = { Name = "spacefractions-public-b" }
}

resource "aws_subnet" "private_a" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = var.private_subnet_a
  availability_zone = "${var.aws_region}a"

  tags = { Name = "spacefractions-private-a" }
}

resource "aws_subnet" "private_b" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = var.private_subnet_b
  availability_zone = "${var.aws_region}b"

  tags = { Name = "spacefractions-private-b" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = { Name = "spacefractions-igw" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = { Name = "spacefractions-public-rt" }
}

resource "aws_route_table_association" "public_a" {
  subnet_id      = aws_subnet.public_a.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "public_b" {
  subnet_id      = aws_subnet.public_b.id
  route_table_id = aws_route_table.public.id
}

# -----------------------------------------------------------------------------
# IAM roles (placeholder policies - adjust before production)
# -----------------------------------------------------------------------------

resource "aws_iam_role" "ecs_task_execution" {
  name = "spacefractions-ecs-task-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role" "ecs_task" {
  name = "spacefractions-ecs-task"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }
      }
    ]
  })
}

# -----------------------------------------------------------------------------
# ECS cluster + service (containerized microservices)
# -----------------------------------------------------------------------------

resource "aws_ecs_cluster" "main" {
  name = "spacefractions-cluster"
}

resource "aws_ecs_task_definition" "gateway" {
  family                   = "spacefractions-gateway"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([
    {
      name      = "gateway"
      image     = var.gateway_image
      essential = true
      portMappings = [
        {
          containerPort = 3000
          hostPort      = 3000
          protocol      = "tcp"
        }
      ]
      environment = [
        { name = "PORT", value = "3000" }
      ]
    }
  ])
}

resource "aws_ecs_service" "gateway" {
  name            = "spacefractions-gateway"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.gateway.arn
  desired_count   = var.gateway_replicas
  launch_type     = "FARGATE"

  network_configuration {
    subnets         = [aws_subnet.private_a.id, aws_subnet.private_b.id]
    security_groups = [aws_security_group.app.id]
  }

  # Load balancer wiring references the ALB defined below.
  load_balancer {
    target_group_arn = aws_lb_target_group.gateway.arn
    container_name   = "gateway"
    container_port   = 3000
  }
}

# -----------------------------------------------------------------------------
# Application Load Balancer
# -----------------------------------------------------------------------------

resource "aws_security_group" "app" {
  name        = "spacefractions-app-sg"
  description = "Space Fractions app security group"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port   = 3000
    to_port     = 3000
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "spacefractions-app-sg" }
}

resource "aws_security_group" "alb" {
  name        = "spacefractions-alb-sg"
  description = "Space Fractions ALB security group"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "spacefractions-alb-sg" }
}

resource "aws_lb" "main" {
  name               = "spacefractions-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = [aws_subnet.public_a.id, aws_subnet.public_b.id]

  tags = { Name = "spacefractions-alb" }
}

resource "aws_lb_target_group" "gateway" {
  name        = "spacefractions-gateway-tg"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"

  health_check {
    path                = "/health"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 3
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = "80"
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = "443"
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.tls_certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.gateway.arn
  }
}

# -----------------------------------------------------------------------------
# PostgreSQL (RDS) - persistence backend
# -----------------------------------------------------------------------------

resource "aws_security_group" "rds" {
  name        = "spacefractions-rds-sg"
  description = "Space Fractions RDS security group"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "spacefractions-rds-sg" }
}

resource "aws_db_subnet_group" "main" {
  name       = "spacefractions-db-subnet"
  subnet_ids = [aws_subnet.private_a.id, aws_subnet.private_b.id]

  tags = { Name = "spacefractions-db-subnet" }
}

resource "aws_db_instance" "postgres" {
  identifier             = "spacefractions-postgres"
  engine                 = "postgres"
  engine_version         = "16"
  instance_class         = var.db_instance_class
  allocated_storage      = 20
  storage_encrypted      = true
  db_name                = var.db_name
  username               = var.db_username
  password               = var.db_password
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  skip_final_snapshot    = false
  final_snapshot_identifier = "spacefractions-final"
  backup_retention_period   = 7
  multi_az               = true

  tags = { Name = "spacefractions-postgres" }
}

# -----------------------------------------------------------------------------
# ElastiCache (Redis) - session/game state cache
# -----------------------------------------------------------------------------

resource "aws_security_group" "redis" {
  name        = "spacefractions-redis-sg"
  description = "Space Fractions Redis security group"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "spacefractions-redis-sg" }
}

resource "aws_elasticache_subnet_group" "main" {
  name       = "spacefractions-redis-subnet"
  subnet_ids = [aws_subnet.private_a.id, aws_subnet.private_b.id]
}

resource "aws_elasticache_cluster" "redis" {
  cluster_id           = "spacefractions-redis"
  engine               = "redis"
  node_type            = "cache.t3.micro"
  num_cache_nodes      = 1
  parameter_group_name = "default.redis7"
  engine_version       = "7.1"
  port                 = 6379
  subnet_group_name    = aws_elasticache_subnet_group.main.name
  security_group_ids   = [aws_security_group.redis.id]

  tags = { Name = "spacefractions-redis" }
}

# -----------------------------------------------------------------------------
# Outputs are defined in outputs.tf (this file focuses on resources).
# Variables are defined in variables.tf (this file focuses on resources).
# -----------------------------------------------------------------------------