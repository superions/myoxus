<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Self-hosted deployment: prebuilt frontend path

[Documentation](../../README.md) / [Operations](../README.md) / [Deployment](./README.md)

The prebuilt path packages already exported Web/Admin roots into the same two
static OCI artifacts as the source-build path. It does not create runtime
frontend containers. One separately selected Nginx serves both materialized
roots with the runtime configuration rendered from
`client/frontends/nginx/myoxus.conf` at startup. See
[the proxy deployment inputs](./reverse-proxy.md) for timeout configuration.

<details>
<summary>On this page</summary>

- [Export and verify](#export-and-verify)
- [Build the static OCI artifacts](#build-the-static-oci-artifacts)
- [Start the local stack](#start-the-local-stack)
- [Verification](#verification)

</details>

## Export and verify

```bash
build/scripts/frontends/export-prebuilt-static.sh
build/scripts/frontends/verify-prebuilt-static.sh
```

The canonical export produces:

- `client/frontends/static/web/`
- `client/frontends/static/admin/`
- `client/frontends/static/api/fonts/`

The retired `client/web/static/` and `client/admin/static/` mirrors must not be
recreated.

## Build the static OCI artifacts

```bash
REVISION="$(git rev-parse HEAD)"
CLIENT_VERSION="$(node build/scripts/release/write-release-identity.mjs \
  --role web --revision "$REVISION" --print-version)"

docker build -f build/web/Dockerfile.prebuilt \
  --build-arg GITHUB_SHA="$REVISION" \
  --build-arg MYOXUS_CLIENT_VERSION="$CLIENT_VERSION" \
  -t myoxus-web-frontend:prebuilt .
docker build -f build/admin/Dockerfile.prebuilt \
  --build-arg GITHUB_SHA="$REVISION" \
  --build-arg MYOXUS_CLIENT_VERSION="$CLIENT_VERSION" \
  -t myoxus-admin-frontend:prebuilt .

build/scripts/frontends/materialize-static-artifacts.sh \
  --web-image myoxus-web-frontend:prebuilt \
  --admin-image myoxus-admin-frontend:prebuilt \
  --output "$PWD/build/server/runtime-frontends/current"
```

Both images end in `scratch`: they have no command, port, webserver or package
manager. The Web artifact also carries the single Nginx configuration, its
basepath renderer, materializer and Swarm deployment file under
`/myoxus-artifact/deployment/`.

The build arguments are mandatory and checked against the repository version.
Both images embed matching release identities. The materializer checks their
OCI labels before extraction and their exact `release.json` after extraction
into an isolated staging directory. Any version or revision mismatch leaves
the existing output tree untouched.

## Start the local stack

```bash
export MYOXUS_FRONTEND_ASSET_ROOT="$PWD/build/server/runtime-frontends/current"
docker compose -f build/server/docker-compose.selfhost.yml up -d frontend
```

`MYOXUS_NGINX_IMAGE` selects the separately maintained upstream Nginx image and
defaults to `nginx:stable-alpine`. Updating it does not require a Myoxus release.
`MYOXUS_STYLE_HOST_DIR` remains writable by the API and read-only in Nginx so
Admin-managed branding survives frontend upgrades.

## Verification

```bash
build/scripts/frontends/test-nginx-topology.sh
build/scripts/server/smoke-frontend-selfhost.sh
curl -fsS http://localhost:3010/health
```

Required routing:

- `/` and Web deep links serve the Web SPA.
- `/adminfrontend/` serves the Admin SPA.
- `/style/*` and `/api/fonts/*` serve materialized/runtime assets.
- `/api/*`, `/graphql`, `/mcp`, `/public/*` and `/socket.io/*` reach the API.

Deploy the complete matching exported roots, including deferred JavaScript/data
assets. A successful SPA boot does not verify assets requested later: open the
emoji and icon panels through the public origin and search/select a value;
also open a persisted document with a permitted Database embed to check its
deferred view delivery and display a saved Mermaid chart through its normal
editor host. Preserve the materializer's matching-release
checks and the [proxy routing](./reverse-proxy.md).

Named document icons and the opened icon panel also require the independent
React catalogue asset. Verify a saved named icon through a fresh deep link and
open the icon panel through the public origin; default/emoji content does not
request that asset. For catalogue delivery failures,
follow [frontend delivery diagnosis](../runbooks/frontend-and-auth.md#deferred-feature-assets-fail).
