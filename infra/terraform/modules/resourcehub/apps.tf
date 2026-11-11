# ---- Container Apps: api (HTTP, scales to zero in dev), worker (KEDA on queue length), jobs --

resource "azurerm_container_app_environment" "this" {
  name                       = "cae-${local.name}"
  location                   = azurerm_resource_group.this.location
  resource_group_name        = azurerm_resource_group.this.name
  log_analytics_workspace_id = azurerm_log_analytics_workspace.this.id
  infrastructure_subnet_id   = azurerm_subnet.apps.id
  tags                       = local.tags
}

locals {
  registry     = azurerm_container_registry.this.login_server
  api_image    = "${local.registry}/resourcehub-api:${var.image_tag}"
  worker_image = "${local.registry}/resourcehub-worker:${var.image_tag}"

  # Every secret is a Key Vault reference resolved by the app identity. Nothing sensitive in env.
  kv_secret = { for k, s in azurerm_key_vault_secret.generated : k => s.versionless_id }
  kv_manual = { for k, s in azurerm_key_vault_secret.manual : k => s.versionless_id }

  common_env = {
    NODE_ENV                 = "production"
    LOG_LEVEL                = "info"
    ROOT_DOMAIN              = local.has_domain ? var.root_domain : "invalid"
    PLATFORM_HOST            = local.platform_host
    TRUST_PROXY              = "true"
    PUBLIC_SCHEME            = "https"
    COOKIE_SECURE            = "true"
    STORAGE_ACCOUNT_URL      = azurerm_storage_account.files.primary_blob_endpoint
    STORAGE_CONTAINER        = azurerm_storage_container.tenant_files.name
    KEY_VAULT_URL            = azurerm_key_vault.this.vault_uri
    AZURE_CLIENT_ID          = azurerm_user_assigned_identity.app.client_id
    DOMAIN_VERIFICATION_MODE = "dns"
    MAIL_TRANSPORT           = "queue"
    OTEL_SERVICE_NAMESPACE   = "resourcehub"
    DEPLOYMENT_ENVIRONMENT   = var.environment
  }
}

resource "azurerm_container_app" "api" {
  name                         = "ca-${local.name}-api"
  container_app_environment_id = azurerm_container_app_environment.this.id
  resource_group_name          = azurerm_resource_group.this.name
  revision_mode                = "Single"
  tags                         = local.tags

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }

  registry {
    server   = local.registry
    identity = azurerm_user_assigned_identity.app.id
  }

  dynamic "secret" {
    for_each = {
      "db-url-app"           = local.kv_secret["db-url-app"]
      "db-url-platform"      = local.kv_secret["db-url-platform"]
      "redis-url"            = local.kv_secret["redis-url"]
      "auth-jwt-secret"      = local.kv_secret["auth-jwt-secret"]
      "appinsights-conn-str" = local.kv_secret["appinsights-conn-str"]
      "oidc-client-secret"   = local.kv_manual["oidc-client-secret"]
    }
    content {
      name                = secret.key
      key_vault_secret_id = secret.value
      identity            = azurerm_user_assigned_identity.app.id
    }
  }

  ingress {
    external_enabled = true
    target_port      = 3000
    transport        = "http"
    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    min_replicas = var.api_min_replicas
    max_replicas = var.api_max_replicas

    container {
      name   = "api"
      image  = local.api_image
      cpu    = 0.5
      memory = "1Gi"

      dynamic "env" {
        for_each = merge(local.common_env, {
          PORT              = "3000"
          AUTH_PROVIDER     = "entra"
          OIDC_ISSUER       = var.oidc.issuer
          OIDC_CLIENT_ID    = var.oidc.client_id
          FRONT_DOOR_ID     = azurerm_cdn_frontdoor_profile.this.resource_guid
          APP_VERSION       = var.image_tag
          OTEL_SERVICE_NAME = "resourcehub-api"
          DB_POOL_MAX       = "10"
        })
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = {
          DATABASE_URL_APP                      = "db-url-app"
          DATABASE_URL_PLATFORM                 = "db-url-platform"
          REDIS_URL                             = "redis-url"
          AUTH_JWT_SECRET                       = "auth-jwt-secret"
          OIDC_CLIENT_SECRET                    = "oidc-client-secret"
          APPLICATIONINSIGHTS_CONNECTION_STRING = "appinsights-conn-str"
        }
        content {
          name        = env.key
          secret_name = env.value
        }
      }

      liveness_probe {
        transport = "HTTP"
        path      = "/api/v1/health"
        port      = 3000
      }
      readiness_probe {
        transport = "HTTP"
        path      = "/api/v1/health"
        port      = 3000
      }
    }

    http_scale_rule {
      name                = "http"
      concurrent_requests = "50"
    }
  }

  depends_on = [azurerm_role_assignment.app]
}

resource "azurerm_container_app" "worker" {
  name                         = "ca-${local.name}-worker"
  container_app_environment_id = azurerm_container_app_environment.this.id
  resource_group_name          = azurerm_resource_group.this.name
  revision_mode                = "Single"
  tags                         = local.tags

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }

  registry {
    server   = local.registry
    identity = azurerm_user_assigned_identity.app.id
  }

  dynamic "secret" {
    for_each = {
      "db-url-app"           = local.kv_secret["db-url-app"]
      "db-url-platform"      = local.kv_secret["db-url-platform"]
      "redis-url"            = local.kv_secret["redis-url"]
      "redis-password"       = local.kv_secret["redis-password"]
      "appinsights-conn-str" = local.kv_secret["appinsights-conn-str"]
    }
    content {
      name                = secret.key
      key_vault_secret_id = secret.value
      identity            = azurerm_user_assigned_identity.app.id
    }
  }

  template {
    min_replicas = var.worker_min_replicas
    max_replicas = 3

    container {
      name   = "worker"
      image  = local.worker_image
      cpu    = 0.25
      memory = "0.5Gi"

      dynamic "env" {
        for_each = merge(local.common_env, {
          OTEL_SERVICE_NAME  = "resourcehub-worker"
          WORKER_CONCURRENCY = "4"
        })
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = {
          DATABASE_URL_APP                      = "db-url-app"
          DATABASE_URL_PLATFORM                 = "db-url-platform"
          REDIS_URL                             = "redis-url"
          APPLICATIONINSIGHTS_CONNECTION_STRING = "appinsights-conn-str"
        }
        content {
          name        = env.key
          secret_name = env.value
        }
      }
    }

    # KEDA: wake the worker when BullMQ has waiting sync jobs (scale to zero when idle).
    custom_scale_rule {
      name             = "bullmq-sync-backlog"
      custom_rule_type = "redis"
      metadata = {
        address    = "${azurerm_redis_cache.this.hostname}:${azurerm_redis_cache.this.ssl_port}"
        listName   = "bull:integration-sync:wait"
        listLength = "5"
        enableTLS  = "true"
      }
      authentication {
        secret_name       = "redis-password"
        trigger_parameter = "password"
      }
    }
  }

  depends_on = [azurerm_role_assignment.app]
}

# One-off jobs run inside the VNet (Postgres is private): bootstrap roles, then migrate.
# `seed` loads the two demo tenants; it is never run by the pipeline, only by hand.
resource "azurerm_container_app_job" "db" {
  for_each                     = { bootstrap = "bootstrap", migrate = "migrate", seed = "seed" }
  name                         = "caj-${local.name}-${each.key}"
  location                     = azurerm_resource_group.this.location
  resource_group_name          = azurerm_resource_group.this.name
  container_app_environment_id = azurerm_container_app_environment.this.id
  replica_timeout_in_seconds   = 600
  replica_retry_limit          = 1
  tags                         = local.tags

  manual_trigger_config {
    parallelism              = 1
    replica_completion_count = 1
  }

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }

  registry {
    server   = local.registry
    identity = azurerm_user_assigned_identity.app.id
  }

  dynamic "secret" {
    for_each = each.key == "bootstrap" ? {
      "db-url-admin"         = local.kv_secret["db-url-admin"]
      "db-password-migrator" = local.kv_secret["db-password-migrator"]
      "db-password-app"      = local.kv_secret["db-password-app"]
      "db-password-platform" = local.kv_secret["db-password-platform"]
      } : each.key == "seed" ? {
      "db-url-platform" = local.kv_secret["db-url-platform"]
      } : {
      "db-url-migrator" = local.kv_secret["db-url-migrator"]
    }
    content {
      name                = secret.key
      key_vault_secret_id = secret.value
      identity            = azurerm_user_assigned_identity.app.id
    }
  }

  template {
    container {
      name    = each.key
      image   = local.api_image
      cpu     = 0.25
      memory  = "0.5Gi"
      command = ["node", "node_modules/@resourcehub/db/dist/cli.js", each.value]

      dynamic "env" {
        for_each = each.key == "bootstrap" ? {
          DATABASE_URL_ADMIN   = "db-url-admin"
          DB_PASSWORD_MIGRATOR = "db-password-migrator"
          DB_PASSWORD_APP      = "db-password-app"
          DB_PASSWORD_PLATFORM = "db-password-platform"
          } : each.key == "seed" ? {
          DATABASE_URL_PLATFORM = "db-url-platform"
          } : {
          DATABASE_URL_MIGRATOR = "db-url-migrator"
        }
        content {
          name        = env.key
          secret_name = env.value
        }
      }
    }
  }

  depends_on = [azurerm_role_assignment.app]
}
