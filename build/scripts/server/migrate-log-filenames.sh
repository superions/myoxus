#!/usr/bin/env bash
# migrate-log-filenames.sh — Rename legacy log files from old format to new format.
#
# Old format: myoxus.log.2026-03-30  (tracing_appender default output)
# New format: myoxus.2026-03-30.log  (builder API with filename_suffix)
#
# Usage: ./migrate-log-filenames.sh [LOG_DIR]
# Default LOG_DIR: /opt/myoxus/data/logs

set -euo pipefail

LOG_DIR="${1:-/opt/myoxus/data/logs}"

if [[ ! -d "$LOG_DIR" ]]; then
    echo "[INFO] Log directory $LOG_DIR does not exist, nothing to migrate."
    exit 0
fi

count=0
for f in "$LOG_DIR"/myoxus.log.*; do
    [[ -f "$f" ]] || continue
    # Extract date suffix: myoxus.log.2026-03-30 → 2026-03-30
    date_part="${f##*.}"
    # Validate it looks like a date YYYY-MM-DD or YYYY-MM-DD-HH
    if [[ "$date_part" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}(-[0-9]{2})?$ ]]; then
        new_name="$LOG_DIR/myoxus.${date_part}.log"
        if [[ ! -f "$new_name" ]]; then
            mv "$f" "$new_name"
            echo "[RENAMED] $f → $new_name"
            ((count++)) || true
        else
            echo "[SKIP] $new_name already exists"
        fi
    fi
done

# Also rename the plain myoxus.log → myoxus.YYYY-MM-DD.log using mtime
if [[ -f "$LOG_DIR/myoxus.log" ]]; then
    date_suffix=$(date -r "$LOG_DIR/myoxus.log" '+%Y-%m-%d' 2>/dev/null || date '+%Y-%m-%d')
    new_name="$LOG_DIR/myoxus.${date_suffix}.log"
    if [[ ! -f "$new_name" ]]; then
        mv "$LOG_DIR/myoxus.log" "$new_name"
        echo "[RENAMED] myoxus.log → $new_name"
        ((count++)) || true
    else
        echo "[SKIP] $new_name already exists (not renaming myoxus.log)"
    fi
fi

echo "[DONE] Migrated $count log file(s)."
