# ADR 0003: OIDC + PKCE sign-in, API-issued access tokens, rotating refresh cookies

- Status: accepted
- Date: 2026-11-10

## Context

Users sign in with Microsoft Entra External ID in Azure. The demo has to run with no cloud
dependencies. One person can belong to several tenants, and tenants live on separate hosts.

## Decision

- **The API is the OIDC relying party (BFF style).** `/auth/login` creates PKCE (S256), `state`
  and `nonce`, seals them in a signed 10-minute `HttpOnly` cookie scoped to the callback path, and
  redirects to the IdP. `/auth/callback` checks state and host, exchanges the code with the
  verifier, and validates the `id_token` against the IdP's JWKS (issuer, audience, nonce, age).
- **One code path, two IdPs.** `AUTH_PROVIDER=dev` mounts a small OIDC provider inside the API
  (discovery, JWKS, code + PKCE, RS256 `id_token`s) with a "sign in as" screen for the seeded
  users. `AUTH_PROVIDER=entra` points the same client at `https://{tenant}.ciamlogin.com/{tenantId}/v2.0`.
  Config refuses `dev` in production.
- **Access token:** a 15-minute HS256 JWT from the API (`typ: at+jwt`) carrying `sub`, the user's
  memberships (`mem`), the issuing tenant (`tid`) and the host kind (`ctx`). It lives in SPA memory
  only, never in localStorage.
- **Refresh token:** a random 256-bit value in an `HttpOnly; SameSite=Lax` cookie (`Secure` in
  Azure) on `/api/v1/auth`. Only its SHA-256 is stored, in `sessions` (tenant-scoped, under RLS)
  or `platform_sessions` (platform role only). It rotates on every use. Presenting a rotated-out
  token revokes the whole family and writes an audit row. A 10-second grace window covers
  two tabs refreshing at once.
- **Binding:** a tenant token only works on the tenant that issued it (`tid` must match the host),
  even for someone who belongs to both. Platform tokens only work on the admin host, and platform
  powers are never granted on a tenant host.
- **Pre-tenant identity:** `app_upsert_user()` and `app_user_memberships()` are narrow SECURITY
  DEFINER functions, so login never needs BYPASSRLS on the app role.
- **CSRF:** refresh/logout need the cookie (SameSite=Lax) and reject a mismatched `Origin`.

## Entra note: redirect URIs

Entra doesn't allow wildcard redirect URIs. With a handful of tenants, register each host's
`/api/v1/auth/callback`. At scale, add a single `auth.` host as the only registered callback,
which hands the user back to the tenant host with a one-time code. The impersonation hand-off in
Phase 4 already uses that mechanism. Login code doesn't change either way.

## Consequences

- Role changes reach an access token within 15 minutes. Removing a member also revokes their
  refresh sessions, so they can't mint new tokens.
- The dev IdP makes the demo self-contained and lets an interviewer switch identities in
  seconds, while still exercising PKCE, JWKS validation and nonce checks end to end.
