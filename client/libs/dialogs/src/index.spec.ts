// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  closeConfirmDialog,
  openConfirmDialog,
  openPromptDialog,
  resetDialogStoreForTests,
  subscribeConfirmDialog,
  subscribePromptDialog,
} from ".";

describe("@myoxus/dialogs store", () => {
  afterEach(() => {
    resetDialogStoreForTests();
    vi.restoreAllMocks();
  });

  test("opens and closes confirm state through one shared command store", () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeConfirmDialog((props) => {
      seen.push(!!props.open);
    });

    openConfirmDialog({ title: "Delete" });
    closeConfirmDialog();

    expect(seen).toEqual([false, true, false]);
    unsubscribe();
  });

  test("runs confirm success lifecycle and auto-closes by default", async () => {
    const onConfirm = vi.fn();
    const onSuccess = vi.fn();
    const seen: boolean[] = [];
    subscribeConfirmDialog((props) => {
      seen.push(!!props.open);
    });

    let currentConfirm: (() => Promise<void> | void) | undefined;
    subscribeConfirmDialog((props) => {
      currentConfirm = props.onConfirm;
    });

    openConfirmDialog({ onConfirm }, { onSuccess });
    await currentConfirm?.();

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(seen[seen.length - 1]).toBe(false);
  });

  test("keeps confirm open and propagates failed confirm actions", async () => {
    const failure = new Error("delete failed");
    const onConfirm = vi.fn().mockRejectedValue(failure);
    const onSuccess = vi.fn();
    let latestOpen = false;
    let currentConfirm: (() => Promise<void> | void) | undefined;

    subscribeConfirmDialog((props) => {
      latestOpen = !!props.open;
      currentConfirm = props.onConfirm;
    });

    openConfirmDialog({ onConfirm }, { onSuccess });

    await expect(currentConfirm?.()).rejects.toThrow(failure);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(latestOpen).toBe(true);
  });

  test("keeps prompt open when auto-close is explicitly disabled", async () => {
    let currentConfirm: ((value: string) => Promise<void> | void) | undefined;
    let latestOpen = false;
    subscribePromptDialog((props) => {
      currentConfirm = props.onConfirm;
      latestOpen = !!props.open;
    });

    openPromptDialog({ onConfirm: vi.fn() }, { autoClose: false });
    await currentConfirm?.("Collection");

    expect(latestOpen).toBe(true);
  });

  test("keeps prompt open and propagates failed prompt actions", async () => {
    const failure = new Error("rename failed");
    let currentConfirm: ((value: string) => Promise<void> | void) | undefined;
    let latestOpen = false;
    subscribePromptDialog((props) => {
      currentConfirm = props.onConfirm;
      latestOpen = !!props.open;
    });

    openPromptDialog({ onConfirm: vi.fn().mockRejectedValue(failure) });

    await expect(currentConfirm?.("Collection")).rejects.toThrow(failure);
    expect(latestOpen).toBe(true);
  });
});
