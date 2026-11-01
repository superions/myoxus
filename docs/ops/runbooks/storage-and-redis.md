# Storage and Redis troubleshooting

[Documentation](../../README.md) / [Operations](../README.md) / [Operations runbooks](./README.md)

Diagnose blob-storage and Redis incidents, restore their connectivity and verify dependent services.

<details>
<summary>On this page</summary>

- [Outgoing TLS trust](#outgoing-tls-trust)
- [Storage issues](#storage-issues)
- [Redis issues](#redis-issues)
- [MIME policy blocks uploads (HTTP 415)](#mime-policy-blocks-uploads-http-415)

</details>

## Outgoing TLS trust

The bootstrap `tls.additional_ca_bundle_path` supplies additional CA roots to
S3, PostgreSQL and every configured Redis role. Redis queue/scheduler and
dedicated Pub/Sub clients retain the same trust across reconnects. `redis://`
remains plaintext; `rediss://` verifies certificates and hostnames. An insecure
Redis TLS URL is rejected. Redis's native public roots are retained when the
global bundle is added.

For PostgreSQL, keep the intended `sslmode` in the connection configuration;
adding a CA does not turn `prefer` or `require` into `verify-full`. SQLx retains
its public roots and any explicit connection CA while adding the global
snapshot before the first pool connects. Restart every process after changing
the bundle. DB-only legacy Git trust does not cover either dependency.

See [additional CA configuration](../configuration/README.md) for loaded
snapshot status and restart requirements.

### Storage initialization errors

**Symptoms:** Server exits with `storage probe failed` or `local storage path not writable`.

**Local storage:**

1. The directory in `storage.root` must exist and be writable by the server process:

   ```bash
   # systemd / native example
   ls -la /opt/myoxus/storage
   sudo chown myoxus:myoxus /opt/myoxus/storage
   sudo chmod 750 /opt/myoxus/storage
   ```

2. In Docker, check that the volume mount exists and is writable:

   ```bash
   docker compose -f build/server/docker-compose.selfhost.yml exec api ls -la /opt/myoxus/data/storage
   ```

3. Check disk space:
   ```bash
   docker compose -f build/server/docker-compose.selfhost.yml exec api df -h /opt/myoxus/data/storage
   ```
   If `storage.min_free_space_mb` is set to a non-zero value and free space is below that threshold, the server refuses to start.

**S3/R2 storage:**

- Verify the bucket name, endpoint URL, access key, and secret key.
- The bucket must exist before starting the server.
- Test credentials with `aws s3 ls s3://your-bucket` or a direct HTTP call.

---

## Storage issues

### Local storage: permission denied

```bash
# systemd / native example: inspect the configured root and its parents
namei -l /opt/myoxus/storage

# Change only the configured storage root after verifying this exact path.
sudo chown myoxus:myoxus /opt/myoxus/storage
sudo chmod 750 /opt/myoxus/storage
```

Do not recursively change a populated storage tree during incident response:
object ownership may be deliberate, and a partial recursive operation can make
the incident worse. If existing objects have incorrect ownership, stop writes,
take a filesystem snapshot, enumerate the affected entries, and apply a bounded
repair to that reviewed list. Abort if the configured root does not resolve to
the expected dedicated Myoxus directory.

In Docker, the `api` container runs as `MYOXUS_API_USER` (default
`1000:1000`). The mounted host data directory (`MYOXUS_DATA_DIR`, default
`build/server/data` when started from the compose directory) must be writable by
that UID/GID:

```bash
# Find the UID used inside the container
docker compose -f build/server/docker-compose.selfhost.yml exec api id

# Resolve and inspect the dedicated host directory before changing anything.
realpath build/server/data
find build/server/data -maxdepth 1 -mindepth 1 -printf '%u:%g %p\n'
```

If the inspected directory is not the dedicated mount for this deployment,
stop. Otherwise stop the API, snapshot the directory, and change only the
specific entry reported as unwritable. Restart the API and require `/ready` plus
an upload/download check before removing the snapshot.

### S3/R2: credential errors

- Verify credentials by making a direct API call:
  ```bash
  # Use the approved credential provider; do not put keys in command history.
  aws s3 ls s3://your-bucket --endpoint-url https://your-endpoint
  ```
- The bucket must exist and the credentials must have `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`, and `s3:ListBucket` permissions.
- For R2, the endpoint format is `https://ACCOUNT_ID.r2.cloudflarestorage.com`.

---

## Redis issues

### Redis connection fails at startup

The server fails hard at startup if Redis is unreachable:

```bash
# Check Redis is running
redis-cli --host localhost --port 6379 ping

# Check from inside the Docker network
docker compose -f build/server/docker-compose.selfhost.yml exec api \
  curl -v telnet://redis:6379
```

Redis is a hard dependency — the server will refuse to start if Redis is unreachable. Ensure Redis is running and `redis.url` is correctly configured.

### Redis roles misconfigured

If you configure per-role Redis URLs, required roles (`session`, `queue`, `lock`) must be reachable. Optional roles (`cache`, `socket`) must also be reachable when explicitly configured.

---

## MIME policy blocks uploads (HTTP 415)

**Symptoms:** Sync run completes but `filesDenied > 0`, or individual file operations return HTTP 415. In `strict` mode, denied files are rejected entirely. In `warn` mode, files sync but log warnings.

**Diagnosis:**

1. Check the current MIME policy configuration:

   ```sql
   SELECT id, value FROM app_configs
   WHERE id LIKE 'git_sync.mime_%';
   ```

2. Find which files were denied. During the Loader stage, denied files are
   logged at DEBUG level. Use the Admin logging control to raise the `git_sync`
   group temporarily; the level takes effect without recreating the container.

   ```graphql
   mutation EnableTemporaryGitSyncDebug {
     admin {
       updateLogModuleLevel(input: { group: "git_sync", level: "DEBUG", autoRevertMinutes: 15 }) {
         group
         level
       }
     }
   }
   ```

   Execute this mutation from an authenticated Admin session, then trigger one
   synthetic sync and inspect the API logs. Do not copy repository credentials
   or file contents into incident records.

3. Check what MIME type was detected for a specific file. The 4-tier detection cascade (magic bytes -> extension -> declared -> fallback) may produce a different type than expected. A file with no recognizable header and no extension resolves to `application/octet-stream`.

**Resolution:**

1. **Add MIME type to allowlist**: Admin GUI -> Git Sync -> Policy -> MIME Policy, or through the structured Admin mutation:

   ```graphql
   mutation UpdateGitSyncMimePolicy($updates: [UpdateAppConfigInput!]!) {
     admin {
       adminUpdateConfig(updates: $updates) {
         applied
         fieldErrors {
           path
           message
         }
       }
     }
   }
   ```

2. **Switch to warn mode** for testing (files sync but produce warnings):

   ```graphql
   mutation UpdateGitSyncMimePolicy($updates: [UpdateAppConfigInput!]!) {
     admin {
       adminUpdateConfig(updates: $updates) {
         applied
         fieldErrors {
           path
           message
         }
       }
     }
   }
   ```

   Supply canonical updates with `module: "git_sync"`; use key
   `mime_allowlist_admin` for the first example and `mime_validation_mode` with
   value `"warn"` for the second.

3. Re-trigger the sync run. Policy changes take effect immediately on the next run.

---
