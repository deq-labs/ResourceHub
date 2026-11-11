# Dev environment: smallest SKUs, scale to zero, tear down when idle (`terraform destroy`).
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
  }
  # State lives in the storage account created by ../../bootstrap. Values come from
  # `-backend-config` in CI (see .github/workflows/deploy.yml), never from this file.
  backend "azurerm" {
    use_azuread_auth = true
    use_oidc         = true
    key              = "resourcehub-dev.tfstate"
  }
}

provider "azurerm" {
  features {
    key_vault {
      purge_soft_delete_on_destroy = true
    }
  }
  storage_use_azuread = true
  use_oidc            = true
}

variable "image_tag" {
  type    = string
  default = "bootstrap"
}
variable "root_domain" {
  type    = string
  default = ""
}
variable "wildcard_certificate_key_vault_id" {
  type    = string
  default = ""
}
variable "oidc_issuer" {
  type    = string
  default = ""
}
variable "oidc_client_id" {
  type    = string
  default = ""
}
variable "alert_email" {
  type    = string
  default = ""
}

module "resourcehub" {
  source                            = "../../modules/resourcehub"
  environment                       = "dev"
  location                          = "eastus2"
  image_tag                         = var.image_tag
  root_domain                       = var.root_domain
  wildcard_certificate_key_vault_id = var.wildcard_certificate_key_vault_id
  oidc                              = { issuer = var.oidc_issuer, client_id = var.oidc_client_id }
  postgres_sku                      = "B_Standard_B1ms"
  api_min_replicas                  = 0
  worker_min_replicas               = 0
  alert_email                       = var.alert_email
}

output "deploy" {
  value = module.resourcehub
}
