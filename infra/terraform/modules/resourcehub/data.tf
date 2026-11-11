# ---- PostgreSQL Flexible Server (private, TLS-only, encrypted at rest by default) ----------

resource "random_password" "pg_admin" {
  length  = 32
  special = false
}

resource "random_password" "db" {
  for_each = toset(["migrator", "app", "platform"])
  length   = 32
  special  = false
}

resource "azurerm_postgresql_flexible_server" "this" {
  name                          = "psql-${local.name}-${random_string.suffix.result}"
  resource_group_name           = azurerm_resource_group.this.name
  location                      = azurerm_resource_group.this.location
  version                       = "16"
  sku_name                      = var.postgres_sku
  storage_mb                    = 32768
  backup_retention_days         = var.environment == "prod" ? 35 : 7
  geo_redundant_backup_enabled  = var.environment == "prod"
  delegated_subnet_id           = azurerm_subnet.postgres.id
  private_dns_zone_id           = azurerm_private_dns_zone.this["postgres"].id
  public_network_access_enabled = false
  administrator_login           = "rhadmin"
  administrator_password        = random_password.pg_admin.result
  zone                          = "1"

  authentication {
    active_directory_auth_enabled = true
    password_auth_enabled         = true
    tenant_id                     = data.azurerm_client_config.current.tenant_id
  }

  tags       = local.tags
  depends_on = [azurerm_private_dns_zone_virtual_network_link.this]

  lifecycle {
    ignore_changes = [zone]
  }
}

resource "azurerm_postgresql_flexible_server_database" "app" {
  name      = "resourcehub"
  server_id = azurerm_postgresql_flexible_server.this.id
  charset   = "UTF8"
  collation = "en_US.utf8"
}

resource "azurerm_postgresql_flexible_server_configuration" "tls" {
  name      = "require_secure_transport"
  server_id = azurerm_postgresql_flexible_server.this.id
  value     = "on"
}

resource "azurerm_postgresql_flexible_server_active_directory_administrator" "admin" {
  count               = var.postgres_entra_admin == null ? 0 : 1
  server_name         = azurerm_postgresql_flexible_server.this.name
  resource_group_name = azurerm_resource_group.this.name
  tenant_id           = data.azurerm_client_config.current.tenant_id
  object_id           = var.postgres_entra_admin.object_id
  principal_name      = var.postgres_entra_admin.principal_name
  principal_type      = var.postgres_entra_admin.principal_type
}

locals {
  pg_host = azurerm_postgresql_flexible_server.this.fqdn
  pg_url = {
    admin    = "postgres://rhadmin:${random_password.pg_admin.result}@${local.pg_host}:5432/resourcehub?sslmode=require"
    migrator = "postgres://resourcehub_migrator:${random_password.db["migrator"].result}@${local.pg_host}:5432/resourcehub?sslmode=require"
    app      = "postgres://resourcehub_app:${random_password.db["app"].result}@${local.pg_host}:5432/resourcehub?sslmode=require"
    platform = "postgres://resourcehub_platform:${random_password.db["platform"].result}@${local.pg_host}:5432/resourcehub?sslmode=require"
  }
}

# ---- Azure Cache for Redis (BullMQ, host cache, rate limits) ------------------------------

resource "azurerm_redis_cache" "this" {
  name                          = "redis-${local.name}-${random_string.suffix.result}"
  location                      = azurerm_resource_group.this.location
  resource_group_name           = azurerm_resource_group.this.name
  capacity                      = 0
  family                        = "C"
  sku_name                      = "Basic"
  non_ssl_port_enabled          = false
  minimum_tls_version           = "1.2"
  public_network_access_enabled = false
  redis_version                 = "6"
  tags                          = local.tags

  redis_configuration {
    # BullMQ requires that keys are never evicted.
    maxmemory_policy = "noeviction"
  }
}

resource "azurerm_private_endpoint" "redis" {
  name                = "pe-${local.name}-redis"
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
  subnet_id           = azurerm_subnet.endpoints.id
  tags                = local.tags

  private_service_connection {
    name                           = "redis"
    private_connection_resource_id = azurerm_redis_cache.this.id
    subresource_names              = ["redisCache"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "redis"
    private_dns_zone_ids = [azurerm_private_dns_zone.this["redis"].id]
  }
}

locals {
  redis_url = "rediss://:${urlencode(azurerm_redis_cache.this.primary_access_key)}@${azurerm_redis_cache.this.hostname}:${azurerm_redis_cache.this.ssl_port}"
}

# ---- Blob Storage: tenant files (private; SAS via user delegation, no shared keys) ----------

resource "azurerm_storage_account" "files" {
  name                            = "st${local.compact}files${random_string.suffix.result}"
  resource_group_name             = azurerm_resource_group.this.name
  location                        = azurerm_resource_group.this.location
  account_tier                    = "Standard"
  account_replication_type        = var.environment == "prod" ? "ZRS" : "LRS"
  min_tls_version                 = "TLS1_2"
  https_traffic_only_enabled      = true
  allow_nested_items_to_be_public = false
  # No account keys at all: every SAS is a user-delegation SAS from the app's managed identity.
  shared_access_key_enabled = false
  tags                      = local.tags

  blob_properties {
    versioning_enabled = true
    delete_retention_policy {
      days = 14
    }
    # Browsers PUT uploads straight to Blob with a short-lived SAS.
    cors_rule {
      allowed_origins    = local.has_domain ? ["https://*.${var.root_domain}"] : ["https://${azurerm_cdn_frontdoor_endpoint.this.host_name}"]
      allowed_methods    = ["GET", "PUT", "HEAD", "OPTIONS"]
      allowed_headers    = ["*"]
      exposed_headers    = ["*"]
      max_age_in_seconds = 3600
    }
  }
}

resource "azurerm_storage_container" "tenant_files" {
  name                  = "tenant-files"
  storage_account_id    = azurerm_storage_account.files.id
  container_access_type = "private"
}

# ---- Key Vault (RBAC; read by the app identity) --------------------------------------------

resource "azurerm_key_vault" "this" {
  name                          = "kv-${local.compact}-${random_string.suffix.result}"
  location                      = azurerm_resource_group.this.location
  resource_group_name           = azurerm_resource_group.this.name
  tenant_id                     = data.azurerm_client_config.current.tenant_id
  sku_name                      = "standard"
  rbac_authorization_enabled    = true
  purge_protection_enabled      = var.environment == "prod"
  soft_delete_retention_days    = 30
  public_network_access_enabled = var.key_vault_public_access
  tags                          = local.tags

  network_acls {
    bypass         = "AzureServices"
    default_action = var.key_vault_public_access ? "Allow" : "Deny"
  }
}

resource "azurerm_private_endpoint" "vault" {
  name                = "pe-${local.name}-kv"
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
  subnet_id           = azurerm_subnet.endpoints.id
  tags                = local.tags

  private_service_connection {
    name                           = "vault"
    private_connection_resource_id = azurerm_key_vault.this.id
    subresource_names              = ["vault"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "vault"
    private_dns_zone_ids = [azurerm_private_dns_zone.this["vault"].id]
  }
}

# The deploying principal writes generated secrets; the app identity only reads them.
resource "azurerm_role_assignment" "deployer_kv" {
  scope                = azurerm_key_vault.this.id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = data.azurerm_client_config.current.object_id
}

resource "random_password" "jwt" {
  length  = 64
  special = false
}

locals {
  generated_secrets = {
    "db-url-admin"         = local.pg_url.admin
    "db-url-migrator"      = local.pg_url.migrator
    "db-url-app"           = local.pg_url.app
    "db-url-platform"      = local.pg_url.platform
    "db-password-migrator" = random_password.db["migrator"].result
    "db-password-app"      = random_password.db["app"].result
    "db-password-platform" = random_password.db["platform"].result
    "redis-url"            = local.redis_url
    "redis-password"       = azurerm_redis_cache.this.primary_access_key
    "auth-jwt-secret"      = random_password.jwt.result
    "appinsights-conn-str" = azurerm_application_insights.this.connection_string
  }
}

resource "azurerm_key_vault_secret" "generated" {
  for_each     = local.generated_secrets
  name         = each.key
  value        = each.value
  key_vault_id = azurerm_key_vault.this.id
  content_type = "generated-by-terraform"
  depends_on   = [azurerm_role_assignment.deployer_kv]
}

# Secrets owned by humans (OIDC client secret, partner credentials). Terraform creates an empty
# placeholder once and never overwrites it, so the real value never enters Terraform state.
resource "azurerm_key_vault_secret" "manual" {
  for_each     = toset(["oidc-client-secret", "partner-soap-password", "partner-feed-token"])
  name         = each.key
  value        = "set-me"
  key_vault_id = azurerm_key_vault.this.id
  content_type = "set-out-of-band"
  depends_on   = [azurerm_role_assignment.deployer_kv]

  lifecycle {
    ignore_changes = [value, content_type]
  }
}

# ---- Container Registry ---------------------------------------------------------------------

resource "azurerm_container_registry" "this" {
  name                = "cr${local.compact}${random_string.suffix.result}"
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
  sku                 = "Basic"
  admin_enabled       = false
  tags                = local.tags
}

# ---- Least-privilege role assignments for the app identity ---------------------------------

resource "azurerm_role_assignment" "app" {
  for_each = {
    acr_pull  = { scope = azurerm_container_registry.this.id, role = "AcrPull" }
    kv_read   = { scope = azurerm_key_vault.this.id, role = "Key Vault Secrets User" }
    blob_data = { scope = azurerm_storage_account.files.id, role = "Storage Blob Data Contributor" }
  }
  scope                = each.value.scope
  role_definition_name = each.value.role
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}
