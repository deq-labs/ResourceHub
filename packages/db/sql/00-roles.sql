-- Cluster-level setup. Runs once as a superuser (docker init, Testcontainers, or an Azure admin).
-- Passwords here are LOCAL DEV ONLY; in Azure the roles are created by Terraform with Key Vault secrets.

-- Owns every table. Used only by drizzle-kit / the migrate script (CI and local).
CREATE ROLE resourcehub_migrator LOGIN PASSWORD 'migrator_dev_pw';

-- The API's role. NOBYPASSRLS and not a table owner, so RLS always applies to it.
CREATE ROLE resourcehub_app LOGIN PASSWORD 'app_dev_pw' NOBYPASSRLS NOINHERIT;

-- Cross-tenant role for the platform-admin module and cross-tenant jobs. Every use is audited.
CREATE ROLE resourcehub_platform LOGIN PASSWORD 'platform_dev_pw' BYPASSRLS NOINHERIT;

-- Lets migrations hand narrow SECURITY DEFINER lookup functions to the platform role.
GRANT resourcehub_platform TO resourcehub_migrator;

CREATE DATABASE resourcehub OWNER resourcehub_migrator;
