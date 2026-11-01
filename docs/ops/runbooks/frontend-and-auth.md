# Frontend and authentication troubleshooting

[Documentation](../../README.md) / [Operations](../README.md) / [Operations runbooks](./README.md)

Diagnose frontend delivery, sign-in and desktop-client incidents using the affected client’s network and logs.

<details>
<summary>On this page</summary>

- [Browser clients remain limited or suspended](#browser-clients-remain-limited-or-suspended)
- [Admin frontend issues](#admin-frontend-issues)
- [Deferred feature assets fail](#deferred-feature-assets-fail)
- [Connected worker has a pending root read](#connected-worker-has-a-pending-root-read)
- [Requests continue after permanent deletion](#requests-continue-after-permanent-deletion)
- [Common configuration errors](#common-configuration-errors)
- [Known issues](#known-issues)

</details>

## Browser clients remain limited or suspended

**Symptoms:** Browser Web shows an update warning or a global update boundary,
new Web data connections are rejected with `client_update_maintenance`, or a
local cache reset remains waiting or failed.

**Action:** Inspect the authoritative state with
`myoxus-cli client-update status --json`. Do not clear browser storage broadly
or invent a per-browser acknowledgement. Follow
[Browser client update control](../administration/client-updates.md) to complete,
fail or abort the exact active operation. A reset waiting on pending data must
finish synchronization; a blocked delete retains its fence and can be retried
from the browser or resumed on the next boot. Lost socket wake-ups heal through
the cache-free control read, reconnect/online read or sparse active-state poll.

### Default `crypto.private_key`

**Symptoms:** Production startup fails with
`insecure default crypto.private_key in production`; a development process logs
a warning. Rotating this key can make encrypted integration credentials
unreadable and invalidates application-signed cursor and RSVP tokens. It does
not revoke PostgreSQL-backed sessions.

Provision a unique key before first start through the deployment's protected
secret-file mechanism. The repository Compose deployment reads
`MYOXUS_CRYPTO_PRIVATE_KEY_FILE` on the host and mounts it as a Docker secret;
the systemd procedure uses a root-readable credential file. Do not paste the
key into YAML, a command argument, shell history, or an incident report. For an
existing installation, follow the credential-rotation procedure owned by the
affected integrations instead of replacing the value during authentication
triage.

---

## Deferred feature assets fail

When an emoji/icon panel, Database embed or Mermaid chart reports a loading error, inspect that first-use
request in the browser Network panel. Record its URL, HTTP status and response
MIME type, then compare the served frontend release identity with the installed
artifact. A JavaScript URL returning HTML often indicates an edge or SPA fallback
routing error; a missing hashed asset can indicate an incomplete or mixed release.

Check the selected matching Web/Admin roots using the existing
[materialization procedure](../deployment/prebuilt-images.md) and
[proxy routing](../deployment/reverse-proxy.md). Restore delivery of the complete
matching artifacts, then use the panel's Retry control. Do not broadly clear
browser storage to repair a missing or misrouted asset.

Named document icons can keep an inert glyph slot or supplied fallback while the
independent React catalogue fails delivery; stored names and document loading
remain intact. Open the existing icon picker and use Retry after repairing asset
delivery. The retry also updates previously mounted named icons. A persistent
module-evaluation failure remains an error; redeploy matching healthy artifacts
rather than declaring recovery merely because another request was issued.

## Connected worker has a pending root read

Distinguish delivery failures from a storage worker that connected successfully
but still has a pending workspace-root read. Inspect the requested worker URL,
status/MIME and actual frontend/worker build identity before diagnosing cache
state. A successful connection alone does not prove root data was read.
A fixed storage manager also detaches its last-reference pool entry before
asynchronous destruction, so a same-key reopen cannot reuse a dying store.
Distinguish that ownership overlap from a fresh store blocked on a legacy IDB
lease; inspect the actual worker generation and pending root read.

Older lease-based IndexedDB document storage can leave an update lease behind
when its worker terminates. That lease expires after 30 seconds, so the next
worker's root read may outlast the normal interactive-shell deadline. The fixed
transactional document cache does not consult those legacy records: it reads a
consistent snapshot/update capture and guards subsequent atomic compaction.
Failed transactions reject; worker termination rolls back uncommitted writes.

Recover with the matching fixed frontend and retire every older cache writer
using the [cache synchronization policy cutover](../administration/client-updates.md#cache-synchronization-policy-cutover).
Preserve cached data and acknowledge pending writes first. Do not shorten leases,
increase startup deadlines, disable SharedWorker/service workers or broadly
reset browser storage to qualify this repair.

## Admin frontend issues

### Static frontend release identity mismatch

**Symptoms:** `materialize-static-artifacts.sh` rejects Web/Admin before
installation, reports an OCI version/revision mismatch, or reports that
`release.json` does not match the image identity.

1. Inspect the immutable image labels:

   ```bash
   docker image inspect --format '{{json .Config.Labels}}' \
     myoxus-web-frontend:<tag>
   docker image inspect --format '{{json .Config.Labels}}' \
     myoxus-admin-frontend:<tag>
   ```

2. Confirm both frontend images have the same complete client version and full
   Git revision. Their source label must be the Myoxus repository, and neither
   image may claim a blanket OCI license.
3. Select a matching Web/Admin pair and run the materializer again. A failed
   attempt is fail-closed and leaves the existing asset root intact.

Do not rename workers, edit extracted `release.json`, or create a compatibility
copy for an old worker version. Rebuild from the intended commit with the root
client version and full revision; the consuming packaged-artifact gate owns the
same contract.

### 404 On `/adminfrontend` or `/adminfrontend/*`

The admin panel is served at `/adminfrontend` (not `/admin`).

1. Verify the single frontend delivery service is running:

   ```bash
   docker compose -f build/server/docker-compose.selfhost.yml ps frontend
   ```

2. Check that `MYOXUS_FRONTEND_ASSET_ROOT/admin/selfhost.html` exists and that
   the mounted `deployment/nginx/myoxus.conf` serves the Admin root directly.

3. If using a reverse proxy (Nginx/Caddy) in front, make sure it forwards all
   browser traffic to the frontend Nginx (port 3010), not directly to the API.

### CORS errors in the browser

- `server.origin` in the config must exactly match the origin the browser uses (scheme + host + port).
- Example: if the browser opens `https://myoxus.example.com`, then `server.origin` must be `https://myoxus.example.com` (not `http://`, not with a trailing slash).
- After changing `server.origin`, restart the API.

### Cookie / session not persisted

- Sessions use cookies with `SameSite=Lax`. Keep browser UI and API on the same
  public origin so the cookie, CSRF, WebSocket, and CORS contracts agree.
- Make sure the public frontend and API share the same domain. The selfhost
  Nginx proxies API requests, so this is handled automatically in the Docker
  setup.
- If accessing the API directly from a different origin, ensure TLS is in use (cookies with `Secure` flag require HTTPS).

---

## Requests continue after permanent deletion

A successful permanent-delete response and a terminal document route do not prove
that client requests stopped. Check the affected document's subsequent metadata,
comment and graph requests, the deletion response, and the matching served
frontend/worker revision. A request started after confirmed local purge indicates
a missing client request fence. A late response to an earlier request does not
prove this defect, and "not found: document" does not mean deleted content returned.

The fixed frontend ends the request generation when Storage confirms the local
purge, even if root membership has not updated yet. Socket deletion notifications
accelerate server reconciliation; ordinary missing documents and access rejection
do not authorize a purge. Preserve cached data and use the existing client update
procedure for the matching artifact. No new server setting, timeout increase or
cache reset is required for this request-lifecycle repair.

## Common configuration errors

### Wrong `server.origin`

**Symptoms:** OAuth login callbacks fail with redirect_uri mismatch. Email links point to wrong host. Browser console shows CORS errors.

**Fix:** `server.origin` must exactly match the scheme + host + port that the browser uses to reach the server.

```yaml
# Correct:
server:
  origin: "https://myoxus.example.com"

# Wrong (missing scheme):
server:
  origin: "myoxus.example.com"

# Wrong (trailing slash):
server:
  origin: "https://myoxus.example.com/"

# Wrong (dev address left in production):
server:
  origin: "http://192.168.30.10:3010"
```

In Docker, `server.origin` is injected from `MYOXUS_SERVER_ORIGIN` which defaults to `http://192.168.30.10:3010` — a local development address. **Always set this for production.**

### Default `crypto.private_key` still in use

Follow the protected secret-file procedure above. A production process rejects
the built-in placeholder; a development warning is not evidence that a
production deployment is correctly provisioned.

### Config not loading / env var not taking effect

**Diagnosis:** Check the startup log for the selected run mode and configuration
validation result. Never print effective secret values while diagnosing source
precedence.

**Common causes:**

1. Wrong env var format. The format is `MYOXUS__SECTION__KEY` (double underscores). Single underscore does not work:

   ```bash
   # Correct:
   MYOXUS__DATABASE__URL=postgres://...
   # Wrong:
   MYOXUS_DATABASE_URL=postgres://...
   ```

2. Runtime overlay not mounted in Docker. Check both ownership boundaries:

   ```bash
   docker compose -f build/server/docker-compose.selfhost.yml exec api ls /opt/myoxus/config/
   docker compose -f build/server/docker-compose.selfhost.yml exec api ls -l /opt/myoxus/runtime-config/local.yaml
   ```

   The immutable image directory contains `default.yaml` and feature files,
   but no operator `local.yaml`. The writable operator mirror is the separate
   `/opt/myoxus/runtime-config/local.yaml` file.

3. A higher-priority source overrides the expected value. The load order is:
   image `default.yaml` < image `${RUN_MODE}.yaml` < optional image
   `local.yaml` < runtime overlay < environment < allowlisted secret files.

---

## Known issues

### Electron opens server connection instead of sign-in

An empty desktop server list intentionally opens the existing server-URL form.
Enter the self-hosted server's origin; registration is persisted only after its
ServerConfig handshake succeeds. Both `Standalone` and `Cloud` deployments use
this flow. A failed handshake does not create a partially configured server.
The next launch restores the last selected server if it still exists.

Inspect the configured origin and the handshake error when connection fails.
Changing Stable/Beta/Internal cannot fix a server address: release channels do
not own the Core server selection. Do not reset the desktop profile, replace
workspace flavours or introduce a product-domain default to bypass a failed
connection. Local data and other registered servers must remain intact.

### Electron server selection, offline theme and cookie isolation

The release channel never selects an API server. Connect a remote server using
its canonical HTTPS origin; plain HTTP is restricted to explicitly configured
local/private origins. `DEV_SERVER_URL` controls renderer development assets
only. The public registration handshake sends no cookies and does not follow
redirects: enter the final origin directly.

Native API requests use `assets://./_server/<id>/...`; Socket.IO carries the
same ID as `myoxusServerId`. A missing/removed ID fails closed. Inspect the
existing `global-state.json` server registration and the active tab context
when diagnosing routing; do not repair this by restoring a channel URL or
copying cookies between profiles. Server cookies live in ID/origin-specific
Electron partitions, including servers on the same host with different ports.
Historical domain-only shared cookies are not imported because their origin
ownership cannot be established safely. Do not delete user profiles to diagnose
an authentication failure.

App, Shell and Popup load bundled `style/theme-fallback.css` before rendering.
`data-myoxus-theme-source="api"` indicates a current server projection;
`electron-fallback` indicates the generated first-paint/offline catalog. The
only persisted theme hint is a server/workspace-scoped slug, never CSS. Check
the exact ID-scoped branding/font requests and the active tab before attributing
a fallback to the wrong theme. Rebuild/package both Main and renderer together;
an old renderer cannot use the new ID-only transport.

### Electron desktop app: "an object could not be cloned" IPC error

**Symptoms:** Electron logs `An object could not be cloned` or `DataCloneError`
after invoking a main-process command while the equivalent Web operation works.

**Meaning:** A main-process handler returned a function, Electron object or
other value outside the Structured Clone contract. This is an Electron IPC
contract violation, not evidence of an invalid API response. Record the affected operation and the installed desktop-client version.

**Action:** Preserve the `namespace:key` handler name from the error and the
Main, renderer and helper logs. Check for a matching desktop-client update,
then repeat the affected flow. Include the operation, version and logs when
reporting a reproducible failure.

### Linux Wayland meetings: "system audio is unavailable"

**Symptoms:** The Electron tray shows `System audio is unavailable
(PipeWire/PulseAudio)`, or enabling Meetings does not expose a usable recording
action on a Wayland desktop.

**Meaning:** Linux capture uses the PulseAudio client API and records the
desktop's `@DEFAULT_MONITOR@`. On PipeWire systems this requires the
`pipewire-pulse` compatibility service and a reachable user audio socket. It
does not require screen capture or microphone privacy permission.

**Action:** Run the checks as the same desktop user that starts Electron:

```bash
pactl info
pactl get-default-sink
pactl get-default-source
wpctl status                         # PipeWire/WirePlumber installations
systemctl --user --no-pager status pipewire pipewire-pulse wireplumber
```

`pactl info` must connect successfully and the default sink must exist. For a
Flatpak build, verify that the application still has the declared Wayland and
PulseAudio sockets:

```bash
flatpak info --show-permissions <myoxus-app-id>
```

The Electron main-process log contains the native operation and PulseAudio
error (`Linux system-audio connection failed` or `Linux system-audio read
failed`). Preserve that error when escalating; do not treat an empty recording
as a successful capture. After repairing or restarting the user audio session,
restart Myoxus so the availability probe and the monitor source are recreated.

### Native recording could not be saved

The recording popup retains Open file and Retry saving. Do not remove the
profile's `recordings` files to diagnose a failed save. Reconnect to the original
server, sign in, and restore write permission before retrying. A recording with
No destination needs an explicit selection from an open workspace; changing the
active workspace does not retarget an already bound recording. A window reload
during delivery releases the old attempt and retains its file and document
identity for retry. Local-file deletion is an explicit action and cannot be
undone through Retry saving.

Saved confirms a persisted playable attachment. Transcript progress and errors
belong to the attachment's existing transcription control and the configured
external STT service; Copilot need not be enabled. Use existing Main, renderer
and server logs when a retry fails. Do not include audio, transcript text or
credentials in an error report.

---
