<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Frontend reverse proxy

[Documentation](../../README.md) / [Operations](../README.md) / [Deployment](./README.md)

Myoxus has one public application origin:

- Web is served from the materialized `web/` root.
- Admin is served from the materialized `admin/` root at `/adminfrontend/`.
- API, MCP, publishing and realtime paths are proxied to `api:3001`.
- `client/frontends/nginx/myoxus.conf` is the single authoritative Nginx
  read-only template and is shipped in the Web OCI artifact.

The standard Compose/Swarm topology runs an operator-selected upstream Nginx as
service `frontend` on port `3010`. Myoxus does not build an Nginx image.

Browser Web retains functional HTTP fallbacks for local evaluation and
explicitly accepted private-network deployments; login, workspace load, and
realtime sync do not depend on secure-context-only APIs. Production operators
must terminate TLS at the external edge so credentials,
sessions, and document traffic are protected in transit. The Myoxus container
does not terminate TLS itself.

<details>
<summary>On this page</summary>

- [TLS edge in front of the frontend service](#tls-edge-in-front-of-the-frontend-service)
- [Custom non-Docker Nginx](#custom-non-docker-nginx)
- [Socket.IO heartbeat budget and activation](#socketio-heartbeat-budget-and-activation)

</details>

## TLS edge in front of the frontend service

An external TLS terminator forwards the complete origin to port 3010; it must
not split Web, Admin and API onto different domains.

### Nginx edge example

```nginx
map $http_upgrade $connection_upgrade {
  default upgrade;
  '' close;
}

server {
  listen 443 ssl;
  server_name myoxus.example.com;

  # Configure the operator-owned certificate and private key here.

  # Recalculate for the configured Engine.IO interval plus pong timeout.
  # This Socket.IO-specific location keeps ordinary HTTP timeouts unchanged.
  location /socket.io/ {
    proxy_pass http://frontend:3010;
    proxy_http_version 1.1;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
  }

  location / {
    proxy_pass http://frontend:3010;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
  }
}
```

### Caddy edge example

```Caddyfile
myoxus.example.com {
  reverse_proxy frontend:3010
}
```

Set `server.origin`/`MYOXUS_SERVER_ORIGIN` to the exact browser-facing URL.
The application Nginx keeps redirects relative and forwards request IDs and
the external protocol to the API.

## Custom non-Docker Nginx

Operators may run Nginx outside the Myoxus stack. Materialize both frontend
artifacts, install `deployment/nginx/myoxus.conf` as
`/etc/nginx/myoxus.conf.template`, and run the shipped
`render-basepath-nginx.sh` during frontend startup. Adapt the operator-owned
template copy to these environmental assumptions:

- `/usr/share/nginx/frontends` points at the materialized asset root.
- `api:3001` resolves to the Myoxus API.
- the startup renderer writes `/etc/nginx/conf.d/default.conf` and
  `/etc/nginx/basepath-extra.conf`; those runtime paths must be writable.

Do not load the unrendered template directly. Compose/Swarm mount it read-only
and write the rendered config to a separate path. Release assets are never
modified in place.

Keep `/mcp`, `/graphql`, `/api/`, `/public/`, `/public-assets/`, `/share/` and
`/socket.io/` before the Web SPA fallback.

## Socket.IO heartbeat budget and activation

The API defaults are `websocket.eio_ping_interval_seconds = 60` and
`websocket.eio_ping_timeout_seconds = 120`. YAML, the matching `MYOXUS__*` ENV
keys, Admin Performance → WebSockets and the existing CLI use one validated
configuration contract. Saved changes require an API restart on every replica;
Admin shows the currently running values and pending restart independently.
`websocket.ping_interval_seconds` controls analytics flushes only.

The frontend deployment ENV variables
`MYOXUS_SOCKET_IO_PROXY_READ_TIMEOUT_SECONDS` and
`MYOXUS_SOCKET_IO_PROXY_SEND_TIMEOUT_SECONDS` both default to 300 seconds.
The startup renderer applies them to `/socket.io/` and generated basepath
Socket.IO routes. Restart/recreate the frontend after changing either input;
inspect `nginx -T` inside the actual frontend to read the loaded values. The
renderer rejects empty, malformed, non-positive and overflowing timer inputs.
Ordinary HTTP, upload, MCP and SSE timeouts retain their own existing settings.

Before raising a heartbeat, compute **interval + timeout** in seconds and set
both proxy values strictly above it. Repeat that check for every external edge,
ingress and Socket.IO-specific overriding location, including a custom
basepath. The API cannot update an independently operated proxy. Deploy the
proxy change first, then restart the API replicas, and verify the Engine.IO
open packet (`pingInterval`/`pingTimeout` in milliseconds), HTTP 101 and ongoing
ping/pong frames through the complete served path. Keep existing polling-session
affinity and WebSocket upgrade forwarding unchanged.
