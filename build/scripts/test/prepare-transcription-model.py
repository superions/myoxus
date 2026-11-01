# SPDX-License-Identifier: AGPL-3.0-or-later
"""Provision the explicit CPU speech fixture; never run during product startup."""

import signal
from pathlib import Path

from huggingface_hub import snapshot_download


MODEL = "Systran/faster-whisper-small"
REVISION = "536b0662742c02347bc0e980a01041f333bce120"


def deadline(_signal, _frame):
    raise TimeoutError("test transcription model download deadline exceeded")


def main():
    signal.signal(signal.SIGALRM, deadline)
    signal.alarm(540)
    snapshot = Path(snapshot_download(MODEL, revision=REVISION, max_workers=2))
    if snapshot.name != REVISION:
        raise RuntimeError("test model snapshot differs from the pinned revision")
    for name in ("README.md", "config.json", "model.bin", "tokenizer.json", "vocabulary.txt"):
        source = snapshot / name
        if not source.is_file() or source.stat().st_size == 0:
            raise RuntimeError(f"test model snapshot is missing {name}")
    # Speaches/faster-whisper resolves the default ref from the cache. Pin that
    # ref explicitly; the serving container is offline and mounts it read-only.
    refs = snapshot.parent.parent / "refs"
    refs.mkdir(exist_ok=True)
    (refs / "main").write_text(REVISION, encoding="utf-8")
    signal.alarm(0)
    print(f"Prepared test speech model {MODEL} at {REVISION}", flush=True)


if __name__ == "__main__":
    main()
