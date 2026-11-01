<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Public publishing operations

[Documentation](../../README.md) / [Operations](../README.md) / [Data operations](./README.md)

Public publishing serves anonymous, read-only HTML without exposing raw
workspace APIs, editor runtime, sync, Web frontend, or Admin frontend. The
canonical Myoxus delivery path is dynamic API rendering:

```text
GET /public/{workspace_id}
GET /public/{workspace_id}/{doc_id}
GET /public-assets/{workspace_id}/{doc_id}/{asset_hash}/{filename}
GET /share/{workspace_id}/{doc_id} -> 307 /public/{workspace_id}/{doc_id}
```

Raw document endpoints and private blob storage directories must never be used
as public-delivery substitutes.

Rendered documents are produced from the editor/Yjs block model by
`myoxus-public-render`, not from a Markdown-to-HTML pass. Operators should
expect semantic HTML for headings, tables, links, inline marks and images. If a
public page shows raw pipe-table rows, missing headings, broken images or
placeholder workspace labels, treat it as a renderer regression.

Public HTML uses the active server-owned theme projection. Dynamic routes link
the workspace-scoped runtime CSS:

```text
/api/branding/theme.css?workspaceId={workspace_id}
```

The theme endpoint resolves the workspace profile first and the global profile
second. `theme_mode=system` follows the browser color-scheme preference;
explicit `light` and `dark` profiles make the standalone public page render in
that mode without requiring Web/Admin JavaScript.

<details>
<summary>On this page</summary>

- [Dynamic deployment](#dynamic-deployment)
- [Non-goal: file publication](#non-goal-file-publication)
- [Configuration](#configuration)
- [Nginx example](#nginx-example)
- [Revocation](#revocation)
- [Caching](#caching)
- [Security notes](#security-notes)
- [Monitoring](#monitoring)
- [Existing selection transition](#existing-selection-transition)

</details>

## Dynamic deployment

Proxy these paths to `myoxus-api`:

```text
/public/
/public-assets/
/share/
/api/branding/theme.css
/api/fonts/
```

For the standard self-host origin this is encoded in
`client/frontends/nginx/myoxus.conf`. Keep these locations before the Web SPA
fallback; otherwise copied public URLs on the configured `server.origin` will
serve the Web app shell instead of anonymous public HTML.

The `{doc_id}` segment is the visible document key copied by Web. It may be an
workspace-local `docs.external_id`; the API resolves it together with the
workspace and keeps the internal UUID private
before ACL and rendering while preserving the visible key in canonical links.

Document breadcrumbs use the current workspace name from the database. The
label `Public workspace` is only a fallback for anonymous workspace index SEO
metadata and must not replace the real workspace title on a document page.

Keep TLS, `server.origin`, and public hostnames consistent. Preserve API
`Cache-Control`, `X-Content-Type-Options`, and `X-Robots-Tag` headers.

Denied anonymous public reads intentionally return `404 Not Found`.

## Non-goal: file publication

Public publishing is not a separate file-publication pipeline.
`myoxus-cli public export` creates an offline HTML snapshot, but it is not the
live publication path and does not replace dynamic `/public/...` routes.

The supported way to publish a document from the product is:

1. Enable workspace sharing.
2. Enable the public workspace boundary in workspace sharing settings.
3. Set `docs.public_mode` through the publish UI/API or the MCP
   `doc_publication_set` tool.
4. Serve `/public/{workspace_id}/{doc_id}` through the API proxy.

MCP publication uses workspace-local external document IDs. Read current state
with `doc_publication_get`; publish with `public: true` and optional mode
`Page`/`Edgeless`, or revoke with `public: false` and no mode. Writes require a
durable idempotency key. Replaying the same semantic request returns the
original result without creating another automatic version; use the read tool
to refresh effective availability. MCP does not enable workspace sharing,
workspace publication, or the global delivery switches.

## Configuration

Public publishing is configured through `public_publishing.*` in the normal
server config stack. Environment overrides use the same convention as the rest
of the server, for example:

```bash
MYOXUS__PUBLIC_PUBLISHING__ENABLED=true
MYOXUS__PUBLIC_PUBLISHING__DYNAMIC_ROUTES_ENABLED=true
MYOXUS__PUBLIC_PUBLISHING__SITE_SHELL__TOC_ENABLED=true
```

Important defaults:

| Field                         | Default    | Purpose                                                                                |
| ----------------------------- | ---------- | -------------------------------------------------------------------------------------- |
| `enabled`                     | `true`     | Master switch for anonymous public delivery.                                           |
| `dynamic_routes_enabled`      | `true`     | Emergency switch for API-served `/public`.                                             |
| `html_cache_ttl_seconds`      | `300`      | Retained configuration compatibility value; revocable dynamic HTML always revalidates. |
| `asset_cache_max_age_seconds` | `31536000` | Retained configuration compatibility value; revocable public assets always revalidate. |

These options do not grant public access. Publishing requires workspace sharing
and `workspaces.public`; document and asset routes additionally require an
active, non-blocked document with `docs.public_mode`. Disabling the workspace
boundary suspends, but does not clear, those document selections.

## Editing HTML templates

Edit the selected `templates.root_dir` under `html/`: public/private Tera shells,
`social_card.svg.tera`, `workspace_page.html.tera`, `rsvp_page.html.tera`,
`assets/public.css`, `assets/public.js` and the four
`i18n/*.json` files. Preserve locale keys, `{count}` and date placeholders
`{month}`, `{day}`, `{year}`. Required files must be nonempty bounded regular
files; symlinked inputs are rejected. Validate edits before deployment: API
startup rejects broken templates/locales before readiness.

Restart the API to capture an edit. Requests continue to check current ACL and
render every time, but use that startup capture. Existing editor documents do
not change. CLI HTML export captures the same configured root on its first HTML
operation; use a new CLI process and re-export to update a snapshot. A restart
alone leaves previously exported HTML, copied shell assets and PNG social cards
unchanged. Snapshot manifests include the catalog hash in `renderer_version`;
activation retains the existing complete-release/current-symlink lifecycle.

## Nginx example

```nginx
server {
    listen 443 ssl http2;
    server_name docs.example.org;

    location /public/ {
        proxy_pass http://myoxus-api;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    location /public-assets/ {
        proxy_pass http://myoxus-api;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    location /share/ {
        proxy_pass http://myoxus-api;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    location /api/branding/theme.css {
        proxy_pass http://myoxus-api;
    }

    location /api/fonts/ {
        proxy_pass http://myoxus-api;
    }
}
```

Directory listing must stay disabled on any adjacent static locations.

## Revocation

Revocation is effective at the origin after `docs.public_mode` is cleared,
workspace publication is disabled, or workspace sharing is disabled. Dynamic
HTML and assets require origin revalidation on reuse. Purge CDN/proxy cache
entries if an external intermediary disregards the origin cache policy. No
revocation can retract a file or page that a visitor already downloaded.

## Caching

- Dynamic HTML and public assets use
  `no-cache, max-age=0, must-revalidate`; every reuse rechecks origin ACL.
- Hashes remain content identities and manifest keys, not permission grants.
- Theme CSS is runtime-projected by `/api/branding/theme.css`; workspace theme
  changes are visible to public pages on the next CSS request.
- Approved web fonts are served through `/api/fonts/...` and should be proxied
  with the same host/origin policy as the theme endpoint.

## Security notes

- Public access is not workspace read access.
- Public assets are served only when present in `public_asset_manifest`.
- Internal blob paths are never exposed.
- Raw Yjs document downloads remain session-protected.
- External links render with `rel="noopener noreferrer"`.
- Public shell JavaScript is framework-free and only handles code copy. It does
  not load Web/Admin/editor bundles or external CDN resources.
- `noindex=true` delivery metadata renders robots headers/meta.
- Do not log cookies, tokens, email addresses, raw Yjs bytes, document content,
  or rendered HTML.

## Monitoring

Track separately:

- HTTP status classes for `/public/`;
- HTTP status classes for `/public-assets/`;
- render failures grouped by `public_publishing`;
- missing public asset manifest entries;
- workspace theme CSS failures for `/api/branding/theme.css?workspaceId=...`;
- revocation-to-404 latency when a document is unpublished.

Raise the `public_publishing` logging group temporarily to `debug` when
diagnosing ACL, renderer or asset materialization failures, then return it to
the production preset.

## Existing selection transition

Before deploying the workspace-boundary enforcement, inventory selected
documents (`docs.public_mode IS NOT NULL`) whose active workspace is private.
Report affected workspace and document counts, and obtain explicit acceptance
that their old anonymous links will be suspended. Do not auto-enable a
workspace and do not clear retained document selections. Re-enabling the
workspace restores still-eligible selections; revoked, deleted or blocked
documents remain unavailable.
