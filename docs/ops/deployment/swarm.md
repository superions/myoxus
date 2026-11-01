<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Docker Swarm deployment

[Documentation](../../README.md) / [Operations](../README.md) / [Deployment](./README.md)

Myoxus publishes exactly three OCI artifacts: the Rust server image and static
Web/Admin artifacts. The static artifacts contain no operating system, process
or Nginx. The Web artifact additionally carries the deployment bundle with the
single Myoxus Nginx configuration and this Swarm topology.

The stack runs one operator-selected upstream Nginx image. It serves both
materialized static roots and proxies API/realtime traffic. Updating Nginx is
therefore independent from a Myoxus release.

<details>
<summary>On this page</summary>

- [Prerequisites](#prerequisites)
- [1. Extract the deployment bundle from the Web artifact](#1-extract-the-deployment-bundle-from-the-web-artifact)
- [2. Prepare the state node](#2-prepare-the-state-node)
- [3. Create external secrets](#3-create-external-secrets)
- [4. Materialize Web and Admin](#4-materialize-web-and-admin)
- [5. Render and deploy](#5-render-and-deploy)
- [6. Verify](#6-verify)
- [Updates and rollback](#updates-and-rollback)
- [Backup ownership](#backup-ownership)
- [Remove the stack](#remove-the-stack)

</details>

## Prerequisites

- Docker Engine 24 or newer and an initialized Swarm.
- One manager from which to deploy.
- One durable node labelled `myoxus.data=true`. PostgreSQL, Redis, API and the
  frontend delivery service are kept on this node because they use local bind
  mounts.
- Immutable server and frontend release tags or full commit tags.
- A public URL and TLS route to port `3010`.

## 1. Extract the deployment bundle from the Web artifact

This bootstrap needs only the published Web image; it does not need a Git
checkout. Run it on the state node:

```bash
export MYOXUS_IMAGE_PREFIX=git.blume29.de/myoxus
export MYOXUS_FRONTEND_IMAGE_TAG=<frontend-release-or-commit-tag>
export WEB_IMAGE="$MYOXUS_IMAGE_PREFIX/myoxus-web-frontend:$MYOXUS_FRONTEND_IMAGE_TAG"

docker pull "$WEB_IMAGE"
deployment_container="$(docker create "$WEB_IMAGE" /__myoxus_static_artifact_only__)"
install -d ./myoxus-deployment
docker cp "$deployment_container:/myoxus-artifact/deployment/." ./myoxus-deployment/
docker rm "$deployment_container"
chmod +x ./myoxus-deployment/*.sh ./myoxus-deployment/nginx/*.sh
```

The resulting authoritative Nginx template is
`myoxus-deployment/nginx/myoxus.conf`. It came from the published frontend
artifact and is rendered into writable runtime configuration during frontend
startup. See [the proxy deployment inputs](./reverse-proxy.md) for timeout
configuration.

## 2. Prepare the state node

```bash
docker node update --label-add myoxus.data=true <state-node-name>
export MYOXUS_SWARM_STATE_ROOT=/srv/myoxus
export MYOXUS_SERVER_IMAGE_TAG=<server-release-or-commit-tag>
docker pull "$MYOXUS_IMAGE_PREFIX/myoxus:$MYOXUS_SERVER_IMAGE_TAG"
sudo --preserve-env=MYOXUS_SWARM_STATE_ROOT,MYOXUS_TEMPLATE_HOST_DIR,MYOXUS_IMAGE_PREFIX,MYOXUS_SERVER_IMAGE_TAG \
  ./myoxus-deployment/prepare-swarm-state.sh
```

The bundled preparation script creates PostgreSQL, Redis, blob, log,
configuration, branding, template, PDF-font and frontend directories. It extracts
the complete `/opt/myoxus/templates` tree from the exact pulled server image
without executing the entrypoint. `MYOXUS_TEMPLATE_HOST_DIR` defaults to
`$MYOXUS_SWARM_STATE_ROOT/templates` and must stay inside that owning state root.
The API mounts the root read-only at `/opt/myoxus/templates`.

Preparation adds missing defaults and version paths and reports differing
existing files; it never overwrites bytes, permissions or ownership. Mail uses
`mail/` with five language folders; native ZIPs use `documents/`. PDF/HTML catalog
files are included by the same copier as their filesystem cutovers ship. The
loaders validate required files before readiness. Review release defaults in a
separate extracted directory, back up edits, change files deliberately and
restart the API service to activate them. Rerun preparation for each selected
server release; keep the state root identical for every deployment.

Admin **Templates → Settings** saves `templates.root_dir` as seen inside the
container. The host path does not override that setting; another container root
requires its corresponding mount. Fonts, ICC, branding, config and blobs remain
outside the root. Filesystem template backups complement the existing
Registry/PDF database and blob backups. See the
[template preparation workflow](docker.md#editable-templates).

## 3. Create external secrets

Create these once on a manager:

```bash
openssl rand -hex 32 | docker secret create myoxus_postgres_password -
openssl rand -hex 32 | docker secret create myoxus_crypto_private_key -
docker secret ls --filter name=myoxus_
```

Never replace the crypto key after encrypted credentials exist. The current
release has no general in-place key-rotation workflow; a separately reviewed
decrypt/re-encrypt migration is required before changing it.

## 4. Materialize Web and Admin

Materialize each frontend revision into its own immutable directory. Do not
overwrite the previous revision; retaining it makes a frontend rollback an
environment-only change.

```bash
export ADMIN_IMAGE="$MYOXUS_IMAGE_PREFIX/myoxus-admin-frontend:$MYOXUS_FRONTEND_IMAGE_TAG"
export MYOXUS_FRONTEND_ASSET_ROOT="$MYOXUS_SWARM_STATE_ROOT/frontends/$MYOXUS_FRONTEND_IMAGE_TAG"

sudo ./myoxus-deployment/materialize-static-artifacts.sh \
  --web-image "$WEB_IMAGE" \
  --admin-image "$ADMIN_IMAGE" \
  --output "$MYOXUS_FRONTEND_ASSET_ROOT" \
  --runtime-style-dir "$MYOXUS_SWARM_STATE_ROOT/style" \
  --pull
```

The materializer verifies both SPA shells, fonts, theme/identity assets, strict
Web/Admin separation and the deployment configuration before atomically
installing the directory. Missing fallback style files are seeded without
overwriting Admin-managed runtime branding. It creates temporary containers only for `docker cp`;
the scratch artifacts are never started.

## 5. Render and deploy

Run on a manager. If the state node is not a manager, copy only
`docker-stack.registry.yml` from the extracted deployment bundle to the
manager. The materialized files themselves remain on the labelled state node.

```bash
export MYOXUS_SERVER_IMAGE_TAG=<server-release-or-commit-tag>
export MYOXUS_FRONTEND_IMAGE_TAG=<frontend-release-or-commit-tag>
export MYOXUS_SERVER_ORIGIN=https://myoxus.example.com
export MYOXUS_SWARM_STATE_ROOT=/srv/myoxus
export MYOXUS_FRONTEND_ASSET_ROOT="$MYOXUS_SWARM_STATE_ROOT/frontends/$MYOXUS_FRONTEND_IMAGE_TAG"
export MYOXUS_FRONTEND_PORT=3010

# Optional: pin or update Nginx independently from Myoxus.
export MYOXUS_NGINX_IMAGE=nginx:stable-alpine

docker stack config \
  --compose-file ./myoxus-deployment/docker-stack.registry.yml \
  >/tmp/myoxus-stack.yml

docker stack deploy \
  --compose-file ./myoxus-deployment/docker-stack.registry.yml \
  --resolve-image always \
  myoxus
```

`MYOXUS_SERVER_ORIGIN` must be the exact browser-facing URL, including an
intentional base path. The `frontend` service is the only published application
service. PostgreSQL and Redis remain inside the encrypted overlay network.

## 6. Verify

The desired topology has PostgreSQL, Redis, API and one frontend delivery
service; there are no Web/Admin runtime services.

```bash
docker stack services myoxus
docker stack ps myoxus --no-trunc
docker service logs --tail 100 myoxus_api
docker service logs --tail 100 myoxus_frontend

curl -fsS http://<swarm-ingress-address>:3010/health
curl -fsS http://<swarm-ingress-address>:3010/info
curl -fsS http://<swarm-ingress-address>:3010/adminfrontend/ >/dev/null
```

The API performs SQL migrations at startup. Accept the deployment only after
the API is healthy and `/info`, Web and Admin all work through the single public
origin.

The server image also contains the trusted local `myoxus-cli`. Run it on the
labelled state node inside the active API task so it consumes the same mounted
database secret file and central configuration as the API:

```bash
api_container="$(docker ps \
  --filter label=com.docker.swarm.service.name=myoxus_api \
  --quiet | head -n 1)"
test -n "$api_container"
docker exec "$api_container" myoxus-cli workspaces list
docker exec "$api_container" myoxus-cli workspaces undelete <workspace-id>
```

Do not put the PostgreSQL URL in argv. Workspace creation, membership,
ownership, management-unit, sharing and soft-delete/restore operations are all
available through the packaged `workspaces` and `shared-workspaces` groups.

## Updates and rollback

For a frontend update, materialize the new Web/Admin tag into a new directory,
change `MYOXUS_FRONTEND_ASSET_ROOT`, and redeploy. For an Nginx security update,
change only `MYOXUS_NGINX_IMAGE`; no Myoxus artifact must be rebuilt. For a
server update, change only `MYOXUS_SERVER_IMAGE_TAG`.

Swarm uses `stop-first` for the API to avoid concurrent migrations. The
frontend delivery service uses `start-first`. A database migration may make an
application downgrade unsafe; restoring an old image is not a database
rollback.

Use the canonical
[Browser client update control](../administration/client-updates.md) runbook when
a rollout needs bounded retries, a temporary Browser Web suspension, a
coordinated reload or a synchronized local Cloud-cache reset. It does not
change Swarm's update order or migration ownership.

## Backup ownership

Back up PostgreSQL and `/srv/myoxus/data` as one recovery point. Also retain
`runtime-config/local.yaml`, `style/`, `pdf-fonts/`, the active frontend tag and
the secret rotation records. Redis is queue/cache state and does not replace an
authoritative PostgreSQL/blob backup.

## Remove the stack

```bash
docker stack rm myoxus
```

This removes services and the overlay network, but not bind-mounted state,
materialized frontend revisions or external secrets.
