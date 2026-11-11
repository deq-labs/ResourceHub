# ---- SPA: static website on Blob, served only through Front Door ---------------------------

resource "azurerm_storage_account" "web" {
  name                            = "st${local.compact}web${random_string.suffix.result}"
  resource_group_name             = azurerm_resource_group.this.name
  location                        = azurerm_resource_group.this.location
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  min_tls_version                 = "TLS1_2"
  https_traffic_only_enabled      = true
  allow_nested_items_to_be_public = false
  shared_access_key_enabled       = false
  tags                            = local.tags
}

resource "azurerm_storage_account_static_website" "web" {
  storage_account_id = azurerm_storage_account.web.id
  index_document     = "index.html"
  error_404_document = "index.html"
}

# ---- Azure Front Door: one edge for every tenant host --------------------------------------
#   *.{root_domain}/api/*  -> API container app (Host forwarded as X-Forwarded-Host)
#   *.{root_domain}/*      -> SPA (static website), SPA-routes rewritten to /index.html

resource "azurerm_cdn_frontdoor_profile" "this" {
  name                = "afd-${local.name}"
  resource_group_name = azurerm_resource_group.this.name
  sku_name            = var.front_door_sku
  tags                = local.tags
}

resource "azurerm_cdn_frontdoor_endpoint" "this" {
  name                     = "ep-${local.name}-${random_string.suffix.result}"
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.this.id
  tags                     = local.tags
}

resource "azurerm_cdn_frontdoor_origin_group" "api" {
  name                     = "api"
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.this.id
  session_affinity_enabled = false

  load_balancing {}

  health_probe {
    path                = "/api/v1/health"
    protocol            = "Https"
    request_type        = "GET"
    interval_in_seconds = 60
  }
}

resource "azurerm_cdn_frontdoor_origin" "api" {
  name                           = "api"
  cdn_frontdoor_origin_group_id  = azurerm_cdn_frontdoor_origin_group.api.id
  enabled                        = true
  host_name                      = azurerm_container_app.api.ingress[0].fqdn
  origin_host_header             = azurerm_container_app.api.ingress[0].fqdn
  certificate_name_check_enabled = true
  http_port                      = 80
  https_port                     = 443
}

resource "azurerm_cdn_frontdoor_origin_group" "web" {
  name                     = "web"
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.this.id
  load_balancing {}
}

resource "azurerm_cdn_frontdoor_origin" "web" {
  name                           = "web"
  cdn_frontdoor_origin_group_id  = azurerm_cdn_frontdoor_origin_group.web.id
  enabled                        = true
  host_name                      = azurerm_storage_account.web.primary_web_host
  origin_host_header             = azurerm_storage_account.web.primary_web_host
  certificate_name_check_enabled = true
}

# Wildcard custom domain (BYO certificate in Key Vault; managed certs can't cover wildcards).
resource "azurerm_cdn_frontdoor_secret" "wildcard" {
  count                    = local.has_domain ? 1 : 0
  name                     = "wildcard-cert"
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.this.id
  secret {
    customer_certificate {
      key_vault_certificate_id = var.wildcard_certificate_key_vault_id
    }
  }
}

resource "azurerm_cdn_frontdoor_custom_domain" "wildcard" {
  count                    = local.has_domain ? 1 : 0
  name                     = "wildcard"
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.this.id
  host_name                = "*.${var.root_domain}"
  tls {
    certificate_type        = "CustomerCertificate"
    cdn_frontdoor_secret_id = azurerm_cdn_frontdoor_secret.wildcard[0].id
  }
}

locals {
  custom_domain_ids = local.has_domain ? [azurerm_cdn_frontdoor_custom_domain.wildcard[0].id] : []
  blob_origin       = trimsuffix(azurerm_storage_account.files.primary_blob_endpoint, "/")
  csp = join("; ", [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data: ${local.blob_origin}",
    "connect-src 'self' ${local.blob_origin}",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self' https://*.ciamlogin.com",
  ])
}

resource "azurerm_cdn_frontdoor_rule_set" "web" {
  name                     = "web"
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.this.id
}

# Client-side routes (no file extension) are served index.html with a 200.
resource "azurerm_cdn_frontdoor_rule" "spa_fallback" {
  name                      = "spafallback"
  cdn_frontdoor_rule_set_id = azurerm_cdn_frontdoor_rule_set.web.id
  order                     = 1
  behavior_on_match         = "Continue"

  conditions {
    url_file_extension_condition {
      operator         = "LessThan"
      match_values     = ["1"]
      negate_condition = false
    }
  }
  actions {
    url_rewrite_action {
      source_pattern          = "/"
      destination             = "/index.html"
      preserve_unmatched_path = false
    }
  }
}

resource "azurerm_cdn_frontdoor_rule" "security_headers" {
  name                      = "securityheaders"
  cdn_frontdoor_rule_set_id = azurerm_cdn_frontdoor_rule_set.web.id
  order                     = 2

  actions {
    response_header_action {
      header_action = "Overwrite"
      header_name   = "Content-Security-Policy"
      value         = local.csp
    }
    response_header_action {
      header_action = "Overwrite"
      header_name   = "Strict-Transport-Security"
      value         = "max-age=31536000; includeSubDomains"
    }
    response_header_action {
      header_action = "Overwrite"
      header_name   = "X-Content-Type-Options"
      value         = "nosniff"
    }
    response_header_action {
      header_action = "Overwrite"
      header_name   = "Referrer-Policy"
      value         = "strict-origin-when-cross-origin"
    }
  }
}

resource "azurerm_cdn_frontdoor_route" "api" {
  name                            = "api"
  cdn_frontdoor_endpoint_id       = azurerm_cdn_frontdoor_endpoint.this.id
  cdn_frontdoor_origin_group_id   = azurerm_cdn_frontdoor_origin_group.api.id
  cdn_frontdoor_origin_ids        = [azurerm_cdn_frontdoor_origin.api.id]
  cdn_frontdoor_custom_domain_ids = local.custom_domain_ids
  patterns_to_match               = ["/api/*"]
  supported_protocols             = ["Http", "Https"]
  https_redirect_enabled          = true
  forwarding_protocol             = "HttpsOnly"
  link_to_default_domain          = true
}

resource "azurerm_cdn_frontdoor_route" "web" {
  name                            = "web"
  cdn_frontdoor_endpoint_id       = azurerm_cdn_frontdoor_endpoint.this.id
  cdn_frontdoor_origin_group_id   = azurerm_cdn_frontdoor_origin_group.web.id
  cdn_frontdoor_origin_ids        = [azurerm_cdn_frontdoor_origin.web.id]
  cdn_frontdoor_custom_domain_ids = local.custom_domain_ids
  cdn_frontdoor_rule_set_ids      = [azurerm_cdn_frontdoor_rule_set.web.id]
  patterns_to_match               = ["/*"]
  supported_protocols             = ["Http", "Https"]
  https_redirect_enabled          = true
  forwarding_protocol             = "HttpsOnly"
  link_to_default_domain          = true

  cache {
    query_string_caching_behavior = "IgnoreQueryString"
    compression_enabled           = true
    content_types_to_compress     = ["text/html", "text/css", "application/javascript", "application/json", "image/svg+xml"]
  }
}

# ---- WAF: per-IP rate limit at the edge (+ OWASP managed rules on Premium) ------------------

resource "azurerm_cdn_frontdoor_firewall_policy" "this" {
  name                = "waf${local.compact}"
  resource_group_name = azurerm_resource_group.this.name
  sku_name            = var.front_door_sku
  enabled             = true
  mode                = "Prevention"
  tags                = local.tags

  custom_rule {
    name                           = "RateLimitPerIp"
    enabled                        = true
    priority                       = 10
    type                           = "RateLimitRule"
    rate_limit_duration_in_minutes = 1
    rate_limit_threshold           = 1000
    action                         = "Block"

    match_condition {
      match_variable     = "RequestUri"
      operator           = "Contains"
      match_values       = ["/"]
      negation_condition = false
    }
  }

  dynamic "managed_rule" {
    for_each = var.front_door_sku == "Premium_AzureFrontDoor" ? [1] : []
    content {
      type    = "Microsoft_DefaultRuleSet"
      version = "2.1"
      action  = "Block"
    }
  }
}

resource "azurerm_cdn_frontdoor_security_policy" "this" {
  name                     = "waf"
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.this.id

  security_policies {
    firewall {
      cdn_frontdoor_firewall_policy_id = azurerm_cdn_frontdoor_firewall_policy.this.id
      association {
        patterns_to_match = ["/*"]
        domain {
          cdn_frontdoor_domain_id = azurerm_cdn_frontdoor_endpoint.this.id
        }
        dynamic "domain" {
          for_each = local.custom_domain_ids
          content {
            cdn_frontdoor_domain_id = domain.value
          }
        }
      }
    }
  }
}

# The deploy pipeline uploads the SPA build with its own (OIDC) identity, no account keys.
resource "azurerm_role_assignment" "deployer_web" {
  scope                = azurerm_storage_account.web.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = data.azurerm_client_config.current.object_id
}
