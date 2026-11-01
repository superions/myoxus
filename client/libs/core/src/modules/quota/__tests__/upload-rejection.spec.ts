/**
 * @vitest-environment node
 *
 * QuotaUploadWatcher transition invariants — P112-QUOTA-VERIFY-C-02
 *
 * The watcher reacts to BlobSyncState emissions from `workspace.engine.blob.state$`.
 * Its job is to fire a user-facing notification (and trigger a quota revalidation)
 * exactly when the storage backend transitions into an over-capacity state.
 *
 * Invariants:
 *   - INV-QUOTA-UPLOAD-TOAST-ON-ENTER: overCapacity false→true fires notify+revalidate
 *   - INV-QUOTA-UPLOAD-TOAST-IDEMPOTENT: overCapacity true→true does NOT re-fire
 *   - INV-QUOTA-UPLOAD-TOAST-RESETS: overCapacity true→false→true fires AGAIN
 *   - INV-QUOTA-UPLOAD-TOAST-BOOT: an initial emission with overCapacity=true fires
 *
 * The component keeps a `wasOverCapacity` ref to track the previous state.
 * These tests mirror that reducer as a pure function so we can exercise every
 * transition without mounting React or the DI tree.
 *
 * Source: client/libs/core/src/modules/quota/views/quota-upload-watcher.tsx
 */
import { describe, expect, test, vi } from "vitest";

interface BlobSyncStateLike {
  overCapacity: boolean;
}

function createWatcher() {
  const notify = vi.fn();
  const revalidate = vi.fn();
  let wasOverCapacity = false;

  const observe = (state: BlobSyncStateLike) => {
    if (state.overCapacity && !wasOverCapacity) {
      wasOverCapacity = true;
      notify();
      revalidate();
    } else if (!state.overCapacity && wasOverCapacity) {
      wasOverCapacity = false;
    }
  };

  return { notify, revalidate, observe };
}

describe("QuotaUploadWatcher — overCapacity transitions", () => {
  test("inv_quota_upload_toast_on_enter — false→true fires notify+revalidate", () => {
    const w = createWatcher();
    w.observe({ overCapacity: false });
    expect(w.notify).not.toHaveBeenCalled();
    expect(w.revalidate).not.toHaveBeenCalled();

    w.observe({ overCapacity: true });
    expect(w.notify).toHaveBeenCalledTimes(1);
    expect(w.revalidate).toHaveBeenCalledTimes(1);
  });

  test("inv_quota_upload_toast_idempotent — true→true does NOT re-fire", () => {
    const w = createWatcher();
    w.observe({ overCapacity: true });
    w.observe({ overCapacity: true });
    w.observe({ overCapacity: true });
    expect(w.notify).toHaveBeenCalledTimes(1);
    expect(w.revalidate).toHaveBeenCalledTimes(1);
  });

  test("inv_quota_upload_toast_resets — true→false→true fires twice", () => {
    const w = createWatcher();
    w.observe({ overCapacity: true });
    w.observe({ overCapacity: false });
    w.observe({ overCapacity: true });
    expect(w.notify).toHaveBeenCalledTimes(2);
    expect(w.revalidate).toHaveBeenCalledTimes(2);
  });

  test("inv_quota_upload_toast_boot — initial true emission fires once", () => {
    const w = createWatcher();
    w.observe({ overCapacity: true });
    expect(w.notify).toHaveBeenCalledTimes(1);
    expect(w.revalidate).toHaveBeenCalledTimes(1);
  });

  test("inv_quota_upload_never_fires_without_overcapacity", () => {
    const w = createWatcher();
    for (let i = 0; i < 5; i++) {
      w.observe({ overCapacity: false });
    }
    expect(w.notify).not.toHaveBeenCalled();
    expect(w.revalidate).not.toHaveBeenCalled();
  });
});
