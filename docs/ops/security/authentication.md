<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Auth and security operations

[Documentation](../../README.md) / [Operations](../README.md) / [Security operations](./README.md)

Authentication config is a high-risk operational area: a wrong public origin
breaks OAuth callbacks, missing SMTP breaks mail-based sign-in, and broad CORS
allow-lists create browser and security issues. This runbook describes the
supported operator path.

<details>
<summary>On this page</summary>

- [Baseline](#baseline)
- [SSO transport diagnostics](#sso-transport-diagnostics)
- [Password and mail flows](#password-and-mail-flows)
- [Immediate user suspension](#immediate-user-suspension)
- [OAuth/OIDC](#oauthoidc)
- [Troubleshooting](#troubleshooting)
- [CAPTCHA](#captcha)
- [CORS and reverse proxy](#cors-and-reverse-proxy)
- [Verification](#verification)

</details>

## Baseline

### Additional HTTP certificate authorities

`tls.additional_ca_bundle_path` is a file/ENV-owned, restart-required path below
the runtime-config directory. OAuth token and UserInfo requests, OIDC discovery
and JWKS, and the Admin OIDC diagnostic consume the same immutable startup CA
snapshot. Public trust roots remain enabled; additional trust does not relax
issuer, hostname, token or redirect validation. Changing the file requires
restarting every server/worker/CLI process. See the [bootstrap and migration
rules](../configuration/README.md); a legacy DB-only Git CA is not global trust.

The shared HTTP trust also covers proxy/assets, document-service, Unsplash
and workspace-webhook clients. Existing URL/SSRF checks and per-consumer
timeouts still apply. AI and veraPDF use their own policy-bound clients with
the same roots; a configured veraPDF validator is not silently disabled if
client initialization fails.

| Setting              | Must be                                          | Why                                                  |
| -------------------- | ------------------------------------------------ | ---------------------------------------------------- |
| `server.origin`      | Exact browser-facing URL, without trailing slash | OAuth callback, mail links, CORS and cookies         |
| TLS                  | Enabled in production                            | Secure cookies and provider callbacks                |
| `crypto.private_key` | Random and secret                                | Integration encryption and application-token signing |
| `mail.smtp_host`     | Set when mail flows are used                     | Invitations, magic links and password/e-mail flows   |
| CAPTCHA              | Operator policy; optional                        | Automated login protection when enabled              |

### CSRF cookie contract

First-party clients read only `myoxus_csrf_token` and send its value as
`x-myoxus-csrf-token` where CSRF validation is required. The cookie remains
client-readable, host-scoped at `/`, `SameSite=Lax`, and Secure for HTTPS
origins. There is no Affine CSRF cookie or header alias and no dual-read path.

Deploy the server and corresponding first-party clients together; reload old
Web/Admin tabs and upgrade native clients. Existing Myoxus sessions remain
valid: an authenticated `GET /api/auth/session` or fresh sign-in issues the new
cookie and expires the retired one. Android restores its existing session and
obtains the new CSRF cookie from that session endpoint instead of reading the
retired datastore key. Sign-out also expires retired residue. A request carrying
only the former CSRF name is rejected, not upgraded into a protected write.
No database migration, session-cookie rename or legacy-client compatibility
layer is introduced by this CSRF cutover.

## SSO transport diagnostics

Provider failures use bounded categories rather than nested error text. Logs
include `trust_snapshot_id` and the phase (`token_exchange`, `userinfo`,
`oidc_discovery`, `oidc_jwks`). Admin diagnostics use the same classifier. No
provider response body, URL query, authorization code, token, cookie or PEM is
included in these diagnoses; public-library root counts are not guessed.

| Category                                                    | Operator check                                                                                                                  |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `tls_unknown_issuer`                                        | Check the loaded additional CA snapshot and the provider's complete certificate chain.                                          |
| `tls_hostname_mismatch`                                     | Match the endpoint hostname to the certificate SAN; do not disable verification.                                                |
| `tls_certificate_expired` / `tls_certificate_not_yet_valid` | Check certificate lifetime and system clocks.                                                                                   |
| `tls_certificate_rejected` / `tls_handshake_failed`         | Check certificate purpose/chain and supported TLS protocol configuration.                                                       |
| `dns_failed`                                                | Check system DNS resolution from the server's network namespace.                                                                |
| `connection_failed` / `timeout`                             | Check routing, firewall, reachability and the consumer's existing timeout.                                                      |
| `http_rejected`                                             | The provider returned a non-success HTTP status; check provider-side credentials and policy without exposing its response body. |
| `invalid_response`                                          | The response is malformed or has the wrong expected shape.                                                                      |

The resolver remains the operating system resolver; a typed wrapper records
the DNS phase without matching localized OS error messages. Root replacement
requires a process restart. Compare snapshot IDs across instances before
concluding that a rollout is active everywhere.

## Password and mail flows

Myoxus can start without SMTP. In that mode mails are not delivered, so
mail-based flows are not operationally usable. Configure SMTP for production
invitations, magic links and password/e-mail operations:

```yaml
mail:
  sender: "Myoxus <noreply@example.com>"
  smtp_host: "smtp.example.com"
  smtp_port: 587
  smtp_transport: starttls
  smtp_verify_certificate: true
  # Set both values for authenticated SMTP, or omit both for a trusted relay.
  smtp_user: null
  smtp_pass: null
  enable_notification_emails: true
```

Admin UI path: **System -> Mail**.

The selected transport is explicit and independent of the port. STARTTLS
refuses servers that do not advertise the upgrade. TLS certificate validation
is enabled by default. The test-mail action uses the same transport builder as
auth, invitation, notification, and fallback delivery.

Password-reset links use `server.origin` and the default local path
`/auth/changePassword`; request headers and Admin clients cannot replace that
origin. `auth.password_reset_ttl_seconds` controls the lifetime of newly issued
tokens (`1800` seconds by default, allowed range `300..=86400`). Changes through
Admin **System -> Security -> Authentication** take effect after a server
restart and do not alter tokens that already exist. A successful reset consumes
the token once and revokes every existing session for that account.

## Immediate user suspension

The Admin **ban user** operation is atomic across the user status, sessions and
MCP API keys. Before the database transaction starts, the server blocks the
user's session epoch. The transaction disables the account, revokes existing
sessions and deletes its API keys. Cached and uncached sessions, as well as the
old API keys, are rejected without an API restart. A failed transaction is
rolled back; a cache failure after commit remains fail-closed.

Re-enabling a user changes only the account status. It never restores revoked
sessions or deleted keys, so the user must sign in again and generate new keys.

## OAuth/OIDC

Myoxus supports Google, GitHub and generic OIDC-compatible providers under
`oauth.providers`. For self-hosted IdPs such as Authentik or Keycloak, use the
provider key `oidc` unless the client surface explicitly sends another provider
name.

Operator checklist:

- `server.origin` is the final browser-facing origin, without a trailing slash.
- The provider redirect URI is `${server.origin}/api/oauth/callback`.
- Client ID and client secret are treated as sensitive configuration.
- The provider name is identical in Admin config, runtime config and the login
  button.
- Generic OIDC providers return an ID token; Myoxus validates signature,
  issuer, audience, expiry and nonce before UserInfo is trusted.
- After configuration, run a preflight/login with a test account and verify the
  resulting Myoxus session and expected OU memberships.

Admin configuration readback masks credential leaves recursively, including
both `clientSecret` and accepted `client_secret` inputs and nested token/secret
fields, while retaining editable non-secret provider fields. Saving a returned
mask leaves the original credential unchanged; supplying a replacement changes
it. Explicitly removing a connection block removes that block rather than
restoring its old masked contents. This protects ordinary Admin configuration
reads and mutation responses; it does not mask or alter historical records
returned by trusted local `audit list/get`.

The generic provider may store an optional directory-read connection in that
same OIDC object. For Authentik:

```yaml
oauth:
  providers:
    oidc:
      # Existing login configuration remains here, unchanged.
      groupDirectory:
        type: authentik
        baseUrl: "https://auth.example.com/provider-prefix"
        # Supply token through the deployment's protected configuration source.
```

The required `token` is a dedicated read credential, not the OIDC login client
secret. Canonical fields are `groupDirectory` and `baseUrl`; their snake_case
aliases are accepted within a source, but duplicate spellings and unknown fields
fail. Partial file/ENV overlays merge before required-field validation. The base
URL retains its deployment path, requires HTTPS (HTTP only for localhost,
127.0.0.1 or IPv6 loopback development), and rejects URL credentials, queries and
fragments. Omitting the block preserves the deployed provider shape; explicitly
setting it to null removes only directory access. It uses the existing effective
provider configuration mechanism, not another config root or forced restart.
This block alone neither tests directory access nor changes login or membership
mapping.

Authentik catalog retrieval uses Bearer-authenticated, read-only
`GET <baseUrl>/api/v3/core/groups/`, preserving the configured deployment prefix
and following every visible numbered page. Use a dedicated active read account
and API token with `authentik_core.view_group` access to every intended group;
write permissions and blanket administrator rights are not required. Verify the
account's intended coverage at Authentik: successful pagination or an empty list
proves only that account's visible catalog, not unrestricted directory access.
Expanded user/parent/child objects are not requested, and response membership
fields are discarded rather than returned or retained in the catalog.

Reads have a three-second per-request and fifteen-second total deadline, at most
100 pages and 10,000 group records, one MiB per response and eight MiB total.
Redirects are rejected; page cursors are numbers, never credential-bearing or
foreign-origin links. Failed pages, changing/incomplete pagination and limits
fail the retrieval rather than reporting a successful partial catalog. IDs are
deduplicated; entries with invalid login claim values or collisions after the
existing slash/whitespace normalization are not selectable. Authentik mappings
use group **names**, preserving case, not catalog IDs or the current person's
membership list. Catalog retrieval does not create OUs or alter memberships and
never participates in the login path.

In Admin, open **Security → OAuth → OIDC → Provider group directory**. Save the
OIDC login configuration first, then choose the directory provider and enter
its read connection. The directory's own **Save** writes only that block on
the current saved provider; it does not save or discard other login/mapping
drafts. Conversely, ordinary OIDC Save keeps the saved directory, not uncommitted
connection edits. Panel and tab changes retain drafts. **Discard** restores the
saved connection; **Remove** stages its removal until directory Save confirms it.
Neither removes the login configuration or its mapping rules.

An empty protected input with “Configured; enter a new value to replace” means
the server returned a mask and the saved credential is unchanged. Entering a
replacement sends it only to Myoxus on save; the response is masked again.
Rejected saves keep the complete draft and display the technical error in the
connection section. Saved/dirty state compares connection fields rather than
JSON property order. Directory loading uses saved values only; connection edits
must be saved or discarded first. Apple and Setup have no directory inputs.

For Keycloak, use a separate confidential client with **Service accounts roles**
enabled in the target realm; the login client is unchanged:

```yaml
oauth:
  providers:
    oidc:
      groupDirectory:
        type: keycloak
        baseUrl: "https://identity.example.com/keycloak"
        realm: "office"
        clientId: "myoxus-directory-read"
        # Supply the required clientSecret through protected configuration.
        claimValueMode: path
```

`realm`, `clientId`, `clientSecret` and `claimValueMode` are required. The last
three fields also accept `client_id`, `client_secret` and `claim_value_mode`
source aliases. `claimValueMode` has no default: `name` must match the login
client's **Group Membership** mapper with **Full group path** off, and `path`
must match that setting on. Keep the mapper's Token Claim Name aligned with
Myoxus `claims.groups` and emit it in the configured ID-token/UserInfo source.
Myoxus uses Keycloak's returned name/path and the existing login normalization;
two branches with the same normalized leaf name are ambiguous in name mode.
Changing modes does not rewrite existing persisted rules.

Give the service-account principal read-only `realm-management` **view-users**
access (Keycloak's built-in group-view permission); **query-groups** alone lists
but does not necessarily permit viewing every group. Do not grant realm-admin,
manage-users or other write roles. Fine-grained group-view grants must cover
every parent and descendant to retrieve the complete hierarchy; verify the
effective service-account roles/scopes, not just the client's configured roles.
No user-membership endpoint is requested.

Each retrieval posts `grant_type=client_credentials` to
`<baseUrl>/realms/<realm>/protocol/openid-connect/token`; its Bearer token exists
only for that retrieval. Groups are read from `/admin/realms/<realm>/groups`
and recursively paginated `groups/<id>/children`, never from a person's claims
or embedded `subGroups`. Realm and group IDs are encoded path segments. The
top-level count bounds all root windows because Keycloak can filter invisible
groups after pagination; short/empty windows do not silently end retrieval.
Count mismatches, denied requests, wrong realms, expired credentials and limits
fail without returning a partial/empty success. The same request/total, page,
record and byte limits as Authentik apply, including token/count response bytes;
the 100-page cap is shared across all root and child pages. Global CA trust and
redirect rejection are unchanged. No token cache, refresh job or login dependency
is introduced. Delivered provider/login qualification is separate from storing
this connection.

Minimal generic provider example:

```yaml
oauth:
  providers:
    oidc:
      clientId: "myoxus"
      # Inject MYOXUS__OAUTH__PROVIDERS__OIDC__CLIENT_SECRET through the
      # deployment's protected secret mechanism.
      issuerUrl: "https://auth.example.com/application/o/myoxus/"
      discoveryUrl: "https://auth.example.com/application/o/myoxus/.well-known/openid-configuration"
      authUrl: "https://auth.example.com/application/o/myoxus/authorize/"
      tokenUrl: "https://auth.example.com/application/o/myoxus/token/"
      userinfoUrl: "https://auth.example.com/application/o/myoxus/userinfo/"
      jwksUrl: "https://auth.example.com/application/o/myoxus/jwks/"
      scopes: ["openid", "profile", "email"]
```

### OIDC discovery, JWKS and ID tokens

When `openid` is configured, Myoxus requires an ID token from the token
endpoint. UserInfo may enrich the profile, but it is not accepted as an
unchecked identity anchor.

Validation rules:

- `iss` must match `issuer_url` or the issuer from discovery.
- `aud` must match `client_id`.
- `exp` must be valid.
- `nonce` must match the OAuth preflight nonce.
- The token must be signed by an asymmetric JWKS key. HMAC/`oct` keys are not
  accepted for ID-token validation.

Discovery and JWKS metadata are cached in-process for 300 seconds. Failed
metadata loads are not cached, so the next login retries the provider. The
caches contain public metadata only; they never contain secrets, tokens, cookies
or user claims. Saving `oauth.providers.oidc` or `oauth.providers.apple`
through Admin config clears the Discovery and JWKS caches immediately across
API instances.

### OIDC claims and OU group mapping

Generic OIDC providers can map provider groups to Myoxus organization units.
This does not grant global admin rights and does not create direct workspace
roles. It only reconciles `organization_unit_member` rows with `source=oidc`.
Manual, import, LDAP and SCIM memberships are preserved.

The descriptor path is the canonical `oauth.providers.oidc` path. Its value is
one structured provider object; Admin and YAML use the typed object shape below
without creating separate child rows:

Provider fields are canonical camelCase in YAML, JSON, Admin and writeback.
Previously deployed snake_case spellings remain accepted as explicit aliases,
including nested claims and group mappings. Do not provide both spellings in
one source object: duplicate aliases and unknown fields fail validation. A
higher-precedence source may replace a field supplied by a lower source.

```yaml
oauth:
  providers:
    oidc:
      clientId: "myoxus"
      # Inject MYOXUS__OAUTH__PROVIDERS__OIDC__CLIENT_SECRET through the
      # deployment's protected secret mechanism.
      issuerUrl: "https://auth.example.com/realms/myoxus"
      discoveryUrl: "https://auth.example.com/realms/myoxus/.well-known/openid-configuration"
      authUrl: "https://auth.example.com/realms/myoxus/protocol/openid-connect/auth"
      tokenUrl: "https://auth.example.com/realms/myoxus/protocol/openid-connect/token"
      userinfoUrl: "https://auth.example.com/realms/myoxus/protocol/openid-connect/userinfo"
      jwksUrl: "https://auth.example.com/realms/myoxus/protocol/openid-connect/certs"
      scopes: ["openid", "profile", "email", "groups"]
      claims:
        subject: "sub"
        email: "email"
        emailVerified: "email_verified"
        name: "name"
        avatar: "picture"
        groups: "groups"
        groupsSource: "userinfo"
      groupMapping:
        enabled: true
        defaultRole: "member"
        removeMissingOidcMemberships: true
        missingGroupsPolicy: "deny_login"
        unknownGroups: "ignore"
        mappings:
          - providerGroup: "dept-finance"
            targetUnitId: "00000000-0000-0000-0000-000000000000"
          - providerGroup: "team-platform"
            targetUnitId: "00000000-0000-0000-0000-000000000000"
            role: "manager"
```

Security rules:

- Valid OU roles are `reader`, `member` and `manager`.
- If a mapping rule omits `role`, `groupMapping.defaultRole` applies.
- `missingGroupsPolicy=deny_login` blocks login before a new local OAuth
  account is created when the configured groups claim is absent.
- `unknownGroups=ignore` skips unmapped provider groups; `deny_login` rejects
  any login containing an unmapped group. API errors report counts, not raw
  group lists.
- `removeMissingOidcMemberships=true` removes stale `source=oidc` memberships
  during the next login, but never deletes manually managed memberships.
- `groupsSource` can be `userinfo`, `id_token` or `both`. Keycloak-style path
  groups such as `/finance/managers` are normalized to `finance/managers`.
- `role=manager` mappings materialize the existing Manager capability through
  the same server path used by Organization admin mutations. Removing the last
  OU manager membership revokes that capability again.
- OIDC sync audit events store counts, roles, unit ids and hashed provider
  references only. They do not store tokens, raw claims or plaintext group
  lists.

The Admin Security page and first-run Config Wizard write this same
`oauth.providers.oidc` object through `adminUpdateConfig`. Their Authentik and
Keycloak presets only derive conventional endpoint URLs from the issuer URL and
set safe claim defaults; they do not create workspace roles or global admin
mapping. Use the server-backed **Test OIDC provider** action to verify
Discovery, JWKS and sample group-claim mapping. The diagnostic response returns
booleans, counts and warnings only; it never returns the client secret, tokens,
raw claims or group names.

### Authentik

Use Authentik's OAuth2/OpenID provider with:

- redirect URI: `${server.origin}/api/oauth/callback`;
- scopes: `openid`, `profile`, `email` and the scope mapping that exposes
  groups when OU sync is used;
- discovery URL under the Authentik application/provider issuer;
- JWKS URL under the same Authentik OIDC application path.

### Keycloak

Use a confidential OpenID Connect client in the target realm:

- redirect URI: `${server.origin}/api/oauth/callback`;
- issuer URL: `https://keycloak.example.com/realms/<realm>`;
- discovery URL: `${issuer}/.well-known/openid-configuration`;
- scopes: `openid`, `profile`, `email` plus a client scope that emits the
  configured `groups` claim when OU sync is used;
- JWKS URL: `${issuer}/protocol/openid-connect/certs`.

If Keycloak emits path-style groups such as `/finance/managers`, Myoxus
normalizes them to `finance/managers` before matching mapping rules.

## Troubleshooting

| Symptom                       | Likely cause                                              | Check                                                                    |
| ----------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------ |
| Provider rejects redirect     | `server.origin` or redirect URI mismatch                  | Compare provider redirect URI with `${server.origin}/api/oauth/callback` |
| Callback sets no session      | Cookie/TLS/SameSite/proxy issue                           | Check browser devtools and reverse proxy headers                         |
| `OIDC_ID_TOKEN_INVALID`       | issuer, audience, expiry, signature or JWKS mismatch      | Verify discovery issuer, client ID and JWKS URL                          |
| `OIDC_ID_TOKEN_NONCE_INVALID` | stale callback or state mismatch                          | Restart login from Myoxus preflight                                      |
| `EMAIL_VERIFICATION_REQUIRED` | provider sent `email_verified=false` or no verified claim | Fix provider e-mail verification policy or Myoxus auth policy            |
| `OIDC_GROUPS_CLAIM_MISSING`   | configured groups claim absent                            | Check scope mappers and `claims.groups`                                  |
| OIDC membership not removed   | login did not succeed or removal disabled                 | Check `removeMissingOidcMemberships` and next successful login           |
| Manual membership remains     | Expected behavior                                         | Manual/import/LDAP/SCIM rows are not overwritten by OIDC sync            |

Raise the normal `auth` logging target for diagnosis. Do not log or persist
client secrets, authorization codes, access tokens, ID tokens, cookies, full
claim payloads or complete provider group lists.

The exact provider structure is documented in [configuration.md](../configuration/reference.md)
and enforced by the Admin config schema. Provider-specific deviations must stay
within the server-owned config contract.

## CAPTCHA

CAPTCHA is self-hosted via ALTCHA and does not call third-party services.
Enable it with:

```bash
myoxus-cli captcha generate-key
```

```yaml
captcha:
  enabled: true
  hmac_key: "REDACTED"
```

Details, rotation and monitoring: [captcha.md](./captcha.md).

## CORS and reverse proxy

- Allow only the real frontend origins.
- Do not set `server.origin` to the internal API URL when users access Myoxus
  through a reverse proxy.
- WebSocket/long-polling must work through the proxy; self-host remains
  resilient in `standalone` deployment type.

## Verification

```bash
curl -fsS http://localhost:3001/ready
curl -sS -X POST http://localhost:3001/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ serverConfig { type deploymentType } }"}' | jq .
```

Then verify in the browser:

- password login;
- CAPTCHA challenge when enabled;
- invitation or magic-link mail when SMTP is enabled;
- full OAuth/OIDC callback when OAuth/OIDC is enabled.
