# One-time bootstrap, run by a human with Owner on the subscription:
#   1. Remote state: a storage account + container (Entra auth only, no keys).
#   2. GitHub Actions identity: an Entra app + service principal with FEDERATED credentials
#      for this repo, so workflows log in with OIDC and no client secret exists anywhere.
#
#   az login && terraform init && terraform apply -var github_repo=deq-labs/ResourceHub
# Then set the printed values as GitHub repository *variables* (not secrets).

terraform {
  required_version = ">= 1.9"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.20"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    azuread = {
      source  = "hashicorp/azuread"
      version = "~> 3.0"
    }
  }
}

provider "azurerm" {
  features {}
  storage_use_azuread = true
}

provider "azuread" {}

variable "github_repo" {
  description = "owner/name of the GitHub repository allowed to deploy."
  type        = string
}

variable "location" {
  type    = string
  default = "eastus2"
}

data "azurerm_client_config" "current" {}
data "azurerm_subscription" "current" {}

resource "random_string" "suffix" {
  length  = 6
  upper   = false
  special = false
}

resource "azurerm_resource_group" "state" {
  name     = "rg-resourcehub-tfstate"
  location = var.location
}

resource "azurerm_storage_account" "state" {
  name                            = "strhubtfstate${random_string.suffix.result}"
  resource_group_name             = azurerm_resource_group.state.name
  location                        = azurerm_resource_group.state.location
  account_tier                    = "Standard"
  account_replication_type        = "ZRS"
  min_tls_version                 = "TLS1_2"
  allow_nested_items_to_be_public = false
  shared_access_key_enabled       = false

  blob_properties {
    versioning_enabled = true
    delete_retention_policy {
      days = 30
    }
  }
}

resource "azurerm_storage_container" "state" {
  name                  = "tfstate"
  storage_account_id    = azurerm_storage_account.state.id
  container_access_type = "private"
}

# ---- GitHub OIDC identity ------------------------------------------------------------------

resource "azuread_application" "github" {
  display_name = "resourcehub-github-actions"
}

resource "azuread_service_principal" "github" {
  client_id = azuread_application.github.client_id
}

locals {
  # Which workflow contexts may obtain a token. Prod deploys only from the `prod` environment,
  # which has required reviewers configured in GitHub (the manual approval gate).
  subjects = {
    main         = "repo:${var.github_repo}:ref:refs/heads/main"
    pull_request = "repo:${var.github_repo}:pull_request"
    env_dev      = "repo:${var.github_repo}:environment:dev"
    env_prod     = "repo:${var.github_repo}:environment:prod"
  }
}

resource "azuread_application_federated_identity_credential" "github" {
  for_each       = local.subjects
  application_id = azuread_application.github.id
  display_name   = "github-${each.key}"
  issuer         = "https://token.actions.githubusercontent.com"
  audiences      = ["api://AzureADTokenExchange"]
  subject        = each.value
}

# Contributor to create resources; RBAC admin so Terraform can grant the app identity its roles.
# Tighten to the two resource groups once they exist.
resource "azurerm_role_assignment" "github" {
  for_each             = toset(["Contributor", "Role Based Access Control Administrator"])
  scope                = data.azurerm_subscription.current.id
  role_definition_name = each.value
  principal_id         = azuread_service_principal.github.object_id
}

resource "azurerm_role_assignment" "github_state" {
  scope                = azurerm_storage_account.state.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azuread_service_principal.github.object_id
}

output "github_variables" {
  description = "Set these as GitHub repository variables (Settings > Secrets and variables > Actions > Variables)."
  value = {
    AZURE_CLIENT_ID         = azuread_application.github.client_id
    AZURE_TENANT_ID         = data.azurerm_client_config.current.tenant_id
    AZURE_SUBSCRIPTION_ID   = data.azurerm_client_config.current.subscription_id
    TFSTATE_RESOURCE_GROUP  = azurerm_resource_group.state.name
    TFSTATE_STORAGE_ACCOUNT = azurerm_storage_account.state.name
    TFSTATE_CONTAINER       = azurerm_storage_container.state.name
  }
}
