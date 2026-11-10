output "resource_group_name" {
  value = azurerm_resource_group.this.name
}

output "acr_login_server" {
  value = azurerm_container_registry.this.login_server
}

output "acr_name" {
  value = azurerm_container_registry.this.name
}

output "api_app_name" {
  value = azurerm_container_app.api.name
}

output "worker_app_name" {
  value = azurerm_container_app.worker.name
}

output "db_job_names" {
  value = { for k, j in azurerm_container_app_job.db : k => j.name }
}

output "web_storage_account" {
  value = azurerm_storage_account.web.name
}

output "front_door_endpoint" {
  description = "Default *.azurefd.net hostname. Point a wildcard CNAME (*.{root_domain}) here."
  value       = azurerm_cdn_frontdoor_endpoint.this.host_name
}

output "front_door_profile_name" {
  value = azurerm_cdn_frontdoor_profile.this.name
}

output "key_vault_name" {
  value = azurerm_key_vault.this.name
}

output "app_insights_name" {
  value = azurerm_application_insights.this.name
}

output "tenant_urls" {
  description = "Where the demo tenants live once DNS points at Front Door."
  value = var.root_domain == "" ? {} : {
    contoso   = "https://contoso.${var.root_domain}"
    northwind = "https://northwind.${var.root_domain}"
    platform  = "https://admin.${var.root_domain}"
  }
}
