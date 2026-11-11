variable "environment" {
  description = "Environment name (dev, prod). Used in resource names and tags."
  type        = string
  validation {
    condition     = contains(["dev", "prod"], var.environment)
    error_message = "environment must be dev or prod."
  }
}

variable "location" {
  description = "Azure region."
  type        = string
  default     = "eastus2"
}

variable "name_prefix" {
  description = "Short prefix for globally unique names (letters/numbers only)."
  type        = string
  default     = "rhub"
}

variable "root_domain" {
  description = "Tenants live at {slug}.{root_domain}; the platform console at admin.{root_domain}. Empty = no custom domain yet (Front Door default endpoint only)."
  type        = string
  default     = ""
}

variable "wildcard_certificate_key_vault_id" {
  description = "Versionless Key Vault certificate id for *.{root_domain}. Front Door managed certs do not cover wildcards, so bring your own. Required when root_domain is set."
  type        = string
  default     = ""
}

variable "image_tag" {
  description = "Container image tag (git SHA) to deploy for api, worker and the migrate job."
  type        = string
  default     = "bootstrap"
}

variable "postgres_sku" {
  description = "Flexible Server SKU. B_Standard_B1ms keeps dev cheap."
  type        = string
  default     = "B_Standard_B1ms"
}

variable "postgres_entra_admin" {
  description = "Entra ID group/user that administers Postgres (object id + display name). Humans use Entra auth; the app uses its least-privilege roles."
  type = object({
    object_id      = string
    principal_name = string
    principal_type = string
  })
  default = null
}

variable "api_min_replicas" {
  description = "0 = scale to zero (dev). Use >=1 in prod to avoid cold starts."
  type        = number
  default     = 0
}

variable "api_max_replicas" {
  type    = number
  default = 5
}

variable "worker_min_replicas" {
  description = "0 lets KEDA scale the worker from the BullMQ queue length."
  type        = number
  default     = 0
}

variable "oidc" {
  description = "Entra External ID app settings for user sign-in. The client secret is stored in Key Vault out of band (never in Terraform state)."
  type = object({
    issuer    = string
    client_id = string
  })
  default = {
    issuer    = ""
    client_id = ""
  }
}

variable "key_vault_public_access" {
  description = "Allow Key Vault data-plane access from the internet (RBAC still applies). Turn off once the deploy runs from a VNet-connected runner."
  type        = bool
  default     = true
}

variable "front_door_sku" {
  description = "Standard_AzureFrontDoor (custom WAF rules) or Premium_AzureFrontDoor (adds managed OWASP rules + Private Link origins)."
  type        = string
  default     = "Standard_AzureFrontDoor"
}

variable "alert_email" {
  description = "Where Azure Monitor alerts go."
  type        = string
  default     = ""
}

variable "tags" {
  type    = map(string)
  default = {}
}
