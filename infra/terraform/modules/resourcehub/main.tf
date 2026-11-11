data "azurerm_client_config" "current" {}

locals {
  name    = "${var.name_prefix}-${var.environment}"
  compact = replace("${var.name_prefix}${var.environment}", "-", "")
  tags = merge({
    app         = "resourcehub"
    environment = var.environment
    managed_by  = "terraform"
  }, var.tags)
  has_domain    = var.root_domain != ""
  platform_host = local.has_domain ? "admin.${var.root_domain}" : "admin.invalid"
}

resource "random_string" "suffix" {
  length  = 5
  upper   = false
  special = false
}

resource "azurerm_resource_group" "this" {
  name     = "rg-${local.name}"
  location = var.location
  tags     = local.tags
}

# ---- Observability -------------------------------------------------------------------------

resource "azurerm_log_analytics_workspace" "this" {
  name                = "log-${local.name}"
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
  sku                 = "PerGB2018"
  retention_in_days   = var.environment == "prod" ? 90 : 30
  tags                = local.tags
}

resource "azurerm_application_insights" "this" {
  name                = "appi-${local.name}"
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
  workspace_id        = azurerm_log_analytics_workspace.this.id
  application_type    = "Node.JS"
  tags                = local.tags
}

# ---- Identity: one user-assigned identity for api, worker and jobs -------------------------

resource "azurerm_user_assigned_identity" "app" {
  name                = "id-${local.name}-app"
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
  tags                = local.tags
}
