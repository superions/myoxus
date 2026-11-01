# Runbook: log file date drift

[Documentation](../../README.md) / [Operations](../README.md) / [Operations runbooks](./README.md)

Keep operational logs bounded, readable and available through rotation and retention changes.

<details>
<summary>On this page</summary>

- [Symptom](#symptom)
- [Log file location](#log-file-location)
- [Diagnosis checklist](#diagnosis-checklist)
- [Fix](#fix)
- [Expected state after fix](#expected-state-after-fix)
- [Related](#related)

</details>

## Symptom

The active log file name does not match the current date. For example, new log entries are being written to `myoxus-20260308.log` when the current date is 2026-03-15.

## Log file location

In Docker Compose deployments the log directory is mounted from the host at `${MYOXUS_DATA_DIR}/logs/` (default: `build/server/data/logs/`). Inside the container the path is `/opt/myoxus/data/logs/`. In bare-metal deployments the path is whatever `logging.file_path` is set to in `config/local.yaml` (e.g. `/opt/myoxus/logs/`).

With `file_path: /opt/myoxus/logs/myoxus.log`, the rolling appender creates
`myoxus.YYYY-MM-DD.log` for daily rotation and
`myoxus.YYYY-MM-DD-HH.log` for hourly rotation. `rotation: never` creates
`myoxus.log`.

## Diagnosis checklist

1. **Verify the active log file**

   Docker Compose:

   ```bash
   find build/server/data/logs -maxdepth 1 -type f -name 'myoxus*.log' \
     -printf '%TY-%Tm-%TdT%TH:%TM:%TS %p\n' | sort -r | head -5
   ```

   Bare-metal:

   ```bash
   find /opt/myoxus/logs -maxdepth 1 -type f -name 'myoxus*.log' \
     -printf '%TY-%Tm-%TdT%TH:%TM:%TS %p\n' | sort -r | head -5
   ```

   The most recently modified file should have today's date in its name.

2. **Check server configuration**

   ```bash
   grep -A5 'rotation' server/config/default.yaml
   grep -A5 'rotation' server/config/local.yaml 2>/dev/null
   ```

   Record the effective `file_path`, `rotation`, and `max_files`; do not assume
   the repository defaults are the deployed values. If `rotation` is `never`,
   there is no retention pruning and a single `myoxus.log` is used.

3. **Check file permissions**

   Docker:

   ```bash
   docker compose -f build/server/docker-compose.selfhost.yml exec api ls -la /opt/myoxus/data/logs/
   ```

   Bare-metal:

   ```bash
   ls -la /opt/myoxus/logs/
   ```

   The server process must have write permission to the logs directory. Confirm
   the error in the API or service log before changing ownership.

4. **Check disk space**

   Docker:

   ```bash
   docker compose -f build/server/docker-compose.selfhost.yml exec api df -h /opt/myoxus/data/logs
   ```

   Bare-metal:

   ```bash
   df -h /opt/myoxus/logs
   ```

   If the filesystem is full, file logging can no longer be relied upon. Preserve
   stdout/journald evidence and follow the operator's storage-pressure procedure.

5. **Check process start time and clock**

   Rotation is performed by the active rolling appender, not by a startup-only
   pruning pass. A restart can recreate the sink but does not explain a healthy
   daily appender continuing to write an old date. Compare the host/container
   clock and process start time:

   ```bash
   # Check server uptime via process start time
   ps -eo pid,lstart,cmd | grep myoxus
   ```

6. **Verify new entries go to the correct file**

   ```bash
   # Trigger a request to generate a log entry
   curl -s http://localhost:3001/health

   # Check which file was just modified
   find build/server/data/logs -maxdepth 1 -type f -name 'myoxus*.log' \
     -printf '%TY-%Tm-%TdT%TH:%TM:%TS %p\n' | sort -r | head -3
   ```

## Fix

If the configuration is correct but the file date is stale:

1. **Correct configuration, clock, or mount state, then recreate the API.**
   Abort if the configured log directory is not the expected dedicated mount.

   ```bash
   build/scripts/server/stack-rebuild-api.sh
   ```

2. **If the directory itself has confirmed wrong ownership**, stop the API,
   snapshot the directory, and change only that directory entry:

   Docker (host-side):

   ```bash
   sudo chown 1000:1000 build/server/data/logs
   sudo chmod 750 build/server/data/logs
   ```

   Bare-metal:

   ```bash
   sudo chown myoxus:myoxus /opt/myoxus/logs
   sudo chmod 750 /opt/myoxus/logs
   ```

3. **If disk is full**, do not feed an unreviewed file list to `rm`. First move
   an explicitly reviewed, already-rotated file to protected storage on another
   filesystem, record its checksum, and confirm free space. Never move the
   newest file or any file still open by the API. The configured rolling
   appender enforces `max_files` for ordinary retention; recurring pressure is
   a capacity or log-volume incident, not a manual-retention workflow.

4. Restart the API, trigger `/health`, and verify that a correctly named current
   file receives the new entry. If not, restore the directory snapshot or moved
   evidence file as applicable and continue diagnosis with stdout/journald.

## Expected state after fix

- A daily file named `myoxus.YYYY-MM-DD.log` with today's date (or the
  corresponding hourly/never name) exists in the configured directory.
- New log entries (verified by `curl http://localhost:3001/health` and checking file modification time) land in today's file.
- Old files beyond `max_files` retention are pruned.

## Related

- [logging.md](../observability/logging.md) — runtime log level management and rotation configuration reference
