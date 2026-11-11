# Runbook: activating the Azure deployment

Everything in Azure is defined in `infra/terraform` and deployed by `.github/workflows/deploy.yml`.
The workflow stays **dormant** (it logs a notice and skips) until the steps below are done.
Nothing in the repo holds a cloud credential.

## 0. Costs and teardown

Dev uses the smallest SKUs: Postgres B1ms, Redis Basic C0, Container Apps on the consumption plan
scaling to zero, Front Door Standard. Expect roughly **$60–90/month** if dev is left running, mostly
Front Door's base fee, Postgres and Redis. Tear it down when idle:

```bash
cd infra/terraform/envs/dev && terraform destroy
```

## 1. Bootstrap (once, by a subscription Owner, locally)

```bash
az login
cd infra/terraform/bootstrap
terraform init
terraform apply -var github_repo=deq-labs/ResourceHub
terraform output github_variables
```

This creates the Terraform state account (Entra auth only, no keys) and an Entra app whose
**federated credentials** trust exactly this repo's `main` branch, PRs, and the `dev`/`prod`
GitHub environments. There's no client secret.

## 2. GitHub settings

**Repository variables** (Settings → Secrets and variables → Actions → _Variables_):

| Variable                                                                 | Value                                                                              |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`            | from `github_variables`                                                            |
| `TFSTATE_RESOURCE_GROUP`, `TFSTATE_STORAGE_ACCOUNT`, `TFSTATE_CONTAINER` | from `github_variables`                                                            |
| `ROOT_DOMAIN`                                                            | e.g. `resourcehub.example.com` (optional at first)                                 |
| `WILDCARD_CERT_KV_ID`                                                    | versionless Key Vault certificate id for `*.ROOT_DOMAIN`                           |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`                                          | Entra External ID (step 4)                                                         |
| `DEV_ACR_NAME`                                                           | the dev registry name (after the first dev deploy), used to promote images to prod |
| `ALERT_EMAIL`                                                            | where alerts go                                                                    |

**Environments:** create `dev` and `prod`. On `prod`, add **required reviewers**. That's the
manual approval gate before a tagged release deploys.

**Branch protection on `main`:** require the CI checks and a review. Agents can't push to `main`.

## 3. First deploy

Merge to `main`. The pipeline:

1. ensures the registry exists,
2. builds both images, scans them with Trivy (fails on CRITICAL), and pushes them,
3. updates the DB jobs to the new image and runs **bootstrap** (creates or rotates the three
   Postgres roles from Key Vault secrets) and **migrate** (as `resourcehub_migrator`),
4. applies everything else, so new code only starts after the schema is ready,
5. builds the SPA and uploads it to the static website,
6. smoke-tests `/api/v1/health` through Front Door.

Load the demo tenants once:

```bash
az containerapp job start -g rg-rhub-dev -n caj-rhub-dev-seed
```

The seeded integrations point at `localhost` mocks. In Azure, edit them under
Admin › Integrations, or use the public providers (country profiles, industry news).

## 4. Sign-in (Entra External ID)

1. Create an External ID tenant and an app registration (web, confidential client).
2. Redirect URIs: `https://contoso.ROOT_DOMAIN/api/v1/auth/callback`,
   `https://northwind.ROOT_DOMAIN/api/v1/auth/callback`, `https://admin.ROOT_DOMAIN/api/v1/auth/callback`.
   Entra doesn't allow wildcards; see ADR 0003 for the single-callback broker pattern at scale.
3. Set `OIDC_ISSUER` = `https://<tenant>.ciamlogin.com/<tenant-id>/v2.0` and `OIDC_CLIENT_ID`.
4. Put the client secret into Key Vault secret `oidc-client-secret`. Terraform created a
   placeholder and never overwrites it:
   `az keyvault secret set --vault-name <kv> -n oidc-client-secret --value '<secret>'`
5. Users sign in with Entra and are matched by `oid`. Make yourself a platform admin once with
   `UPDATE users SET is_platform_admin = true WHERE email = '...'` via an Entra-authenticated
   Postgres admin session.

## 5. Domain and two live tenants

1. Put a wildcard certificate for `*.ROOT_DOMAIN` into Key Vault and grant Front Door access
   (Front Door managed certificates don't cover wildcards).
2. DNS: `*.ROOT_DOMAIN CNAME <front_door_endpoint>`, plus the `_dnsauth` TXT record Front Door asks for.
3. Re-run the deploy. `contoso.ROOT_DOMAIN` and `northwind.ROOT_DOMAIN` are live; `admin.ROOT_DOMAIN`
   is the platform console.
4. **Tenant custom domains** (e.g. `hub.contoso-mfg.com`): the tenant proves ownership in-app
   (TXT record, Admin › Domains). An operator then adds the hostname as a Front Door custom domain
   with a managed certificate. Automating that last step through the ARM API is the next item on the list.

## 6. Partner secrets

`kv:` secret refs resolve through the app's managed identity, for example:

```bash
az keyvault secret set --vault-name <kv> -n partner-soap-password --value '...'
```

Then set the integration's secret reference to `kv:partner-soap-password`. `env:` refs are refused in production.
