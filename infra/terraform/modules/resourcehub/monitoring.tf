# ---- Alerts: what pages a human ---------------------------------------------------------------

resource "azurerm_monitor_action_group" "oncall" {
  name                = "ag-${local.name}-oncall"
  resource_group_name = azurerm_resource_group.this.name
  short_name          = "rhoncall"
  tags                = local.tags

  dynamic "email_receiver" {
    for_each = var.alert_email == "" ? [] : [var.alert_email]
    content {
      name                    = "oncall"
      email_address           = email_receiver.value
      use_common_alert_schema = true
    }
  }
}

locals {
  appi_scope = [azurerm_application_insights.this.id]
}

# API: more than 5% of requests failing (5xx) over 10 minutes.
resource "azurerm_monitor_scheduled_query_rules_alert_v2" "api_error_rate" {
  name                 = "alert-${local.name}-api-5xx-rate"
  resource_group_name  = azurerm_resource_group.this.name
  location             = azurerm_resource_group.this.location
  scopes               = local.appi_scope
  severity             = 1
  evaluation_frequency = "PT5M"
  window_duration      = "PT10M"
  description          = "API 5xx rate above 5% (excluding health probes)."
  tags                 = local.tags

  criteria {
    query                   = <<-KQL
      requests
      | where name !has "/health"
      | summarize total = count(), failed = countif(toint(resultCode) >= 500)
      | extend rate = iff(total == 0, 0.0, todouble(failed) / total)
      | project rate
    KQL
    time_aggregation_method = "Maximum"
    metric_measure_column   = "rate"
    operator                = "GreaterThan"
    threshold               = 0.05
    failing_periods {
      minimum_failing_periods_to_trigger_alert = 1
      number_of_evaluation_periods             = 1
    }
  }

  action {
    action_groups = [azurerm_monitor_action_group.oncall.id]
  }
}

# API latency: p95 over 1.5s for 15 minutes.
resource "azurerm_monitor_scheduled_query_rules_alert_v2" "api_latency" {
  name                 = "alert-${local.name}-api-p95"
  resource_group_name  = azurerm_resource_group.this.name
  location             = azurerm_resource_group.this.location
  scopes               = local.appi_scope
  severity             = 2
  evaluation_frequency = "PT5M"
  window_duration      = "PT15M"
  description          = "API p95 latency above 1500 ms."
  tags                 = local.tags

  criteria {
    query                   = <<-KQL
      requests
      | where name !has "/health"
      | summarize p95 = percentile(duration, 95)
    KQL
    time_aggregation_method = "Maximum"
    metric_measure_column   = "p95"
    operator                = "GreaterThan"
    threshold               = 1500
    failing_periods {
      minimum_failing_periods_to_trigger_alert = 1
      number_of_evaluation_periods             = 1
    }
  }

  action {
    action_groups = [azurerm_monitor_action_group.oncall.id]
  }
}

# Integrations: repeated failed runs (any tenant) in 30 minutes, from the worker's spans.
resource "azurerm_monitor_scheduled_query_rules_alert_v2" "integration_failures" {
  name                 = "alert-${local.name}-integration-failures"
  resource_group_name  = azurerm_resource_group.this.name
  location             = azurerm_resource_group.this.location
  scopes               = local.appi_scope
  severity             = 2
  evaluation_frequency = "PT15M"
  window_duration      = "PT30M"
  description          = "Five or more failed integration runs in 30 minutes. Check the partner and the circuit breaker."
  tags                 = local.tags

  criteria {
    query                   = <<-KQL
      dependencies
      | union requests
      | where name startswith "integration." and tostring(customDimensions["integration.outcome"]) == "failed"
      | summarize failures = count() by tenant = tostring(customDimensions["tenant.id"])
    KQL
    time_aggregation_method = "Total"
    metric_measure_column   = "failures"
    operator                = "GreaterThanOrEqual"
    threshold               = 5
    dimension {
      name     = "tenant"
      operator = "Include"
      values   = ["*"]
    }
    failing_periods {
      minimum_failing_periods_to_trigger_alert = 1
      number_of_evaluation_periods             = 1
    }
  }

  action {
    action_groups = [azurerm_monitor_action_group.oncall.id]
  }
}

# Security signal: a refresh-token reuse means a token was probably stolen.
resource "azurerm_monitor_scheduled_query_rules_alert_v2" "token_reuse" {
  name                 = "alert-${local.name}-refresh-reuse"
  resource_group_name  = azurerm_resource_group.this.name
  location             = azurerm_resource_group.this.location
  scopes               = local.appi_scope
  severity             = 1
  evaluation_frequency = "PT5M"
  window_duration      = "PT5M"
  description          = "Refresh-token reuse detected (possible token theft). The session family was revoked; review the tenant audit log."
  tags                 = local.tags

  criteria {
    query                   = <<-KQL
      requests
      | where name has "/auth/refresh" and resultCode == "401"
      | summarize n = count()
    KQL
    time_aggregation_method = "Total"
    metric_measure_column   = "n"
    operator                = "GreaterThan"
    threshold               = 20
    failing_periods {
      minimum_failing_periods_to_trigger_alert = 1
      number_of_evaluation_periods             = 1
    }
  }

  action {
    action_groups = [azurerm_monitor_action_group.oncall.id]
  }
}

# Postgres CPU sustained above 80%.
resource "azurerm_monitor_metric_alert" "postgres_cpu" {
  name                = "alert-${local.name}-pg-cpu"
  resource_group_name = azurerm_resource_group.this.name
  scopes              = [azurerm_postgresql_flexible_server.this.id]
  severity            = 2
  frequency           = "PT5M"
  window_size         = "PT15M"
  description         = "Postgres CPU above 80% for 15 minutes."
  tags                = local.tags

  criteria {
    metric_namespace = "Microsoft.DBforPostgreSQL/flexibleServers"
    metric_name      = "cpu_percent"
    aggregation      = "Average"
    operator         = "GreaterThan"
    threshold        = 80
  }

  action {
    action_group_id = azurerm_monitor_action_group.oncall.id
  }
}

# Redis memory: BullMQ uses noeviction, so a full cache means failed enqueues.
resource "azurerm_monitor_metric_alert" "redis_memory" {
  name                = "alert-${local.name}-redis-mem"
  resource_group_name = azurerm_resource_group.this.name
  scopes              = [azurerm_redis_cache.this.id]
  severity            = 1
  frequency           = "PT5M"
  window_size         = "PT15M"
  description         = "Redis memory above 85% (noeviction: writes will start failing)."
  tags                = local.tags

  criteria {
    metric_namespace = "Microsoft.Cache/redis"
    metric_name      = "usedmemorypercentage"
    aggregation      = "Maximum"
    operator         = "GreaterThan"
    threshold        = 85
  }

  action {
    action_group_id = azurerm_monitor_action_group.oncall.id
  }
}
