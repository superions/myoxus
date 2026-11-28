// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { MyoxusConfirmEventRemovalRequest } from "@virgultum/editor/shared/services";
import { MyoxusHostCapability } from "@virgultum/editor/shared/services";
import { BlockSelection } from "@virgultum/editor/std";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { flushFrame } from "../../harness/pointer.js";
import { insertTestNote, mountTestSession } from "../../harness/session.js";

function enableEventHostCapabilities(): void {
  const host = window.myoxusHostService;
  Object.defineProperty(host, "capabilities", {
    value: new Set<MyoxusHostCapability>([
      MyoxusHostCapability.ResolveEventData,
      MyoxusHostCapability.OpenEventEditDialog,
      MyoxusHostCapability.ConfirmEventBlockRemoval,
    ]),
    writable: true,
    configurable: true,
    enumerable: true,
  });
}

describe("EventBlockComponent host-service lifecycle in BlockStdScope", () => {
  beforeEach(async () => {
    return mountTestSession("edgeless");
  });

  test("resolves event data on mount and invokes openEventEditDialog when clicked", async () => {
    enableEventHostCapabilities();
    const resolveEventData = vi.fn(async () => ({
      title: "Sprint planning",
      startsAt: "2026-06-15T10:00:00Z",
      endsAt: "2026-06-15T11:00:00Z",
      allDay: false,
      tagColor: null,
    }));
    const openEventEditDialog = vi.fn(async () => null);
    window.myoxusHostService.resolveEventData = resolveEventData;
    window.myoxusHostService.openEventEditDialog = openEventEditDialog;

    const noteId = insertTestNote(doc);
    const eventBlockId = doc.addBlock(
      "myoxus:event",
      { workspaceId: "ws-calendar-1", eventId: "evt-101" },
      noteId,
    );
    await flushFrame();

    const blockEl = editor.host!.view.getBlock(eventBlockId);
    expect(blockEl).toBeInstanceOf(HTMLElement);

    await expect
      .poll(() =>
        blockEl!
          .querySelector<HTMLElement>('[data-testid="editor-event-card"]')
          ?.getAttribute("data-state"),
      )
      .toBe("ready");

    expect(resolveEventData).toHaveBeenCalledWith({
      workspaceId: "ws-calendar-1",
      eventId: "evt-101",
    });

    const card = blockEl!.querySelector<HTMLButtonElement>(
      '[data-testid="editor-event-card"]',
    )!;
    expect(card.textContent).toContain("Sprint planning");

    card.click();
    await flushFrame();

    expect(openEventEditDialog).toHaveBeenCalledWith({
      workspaceId: "ws-calendar-1",
      eventId: "evt-101",
      sourceDocId: doc.id,
    });
  });

  test("invokes confirmEventBlockRemoval on Delete and removes block only when confirmed", async () => {
    enableEventHostCapabilities();
    window.myoxusHostService.resolveEventData = vi.fn(async () => ({
      title: "Release review",
      startsAt: "2026-06-16T14:00:00Z",
      endsAt: "2026-06-16T15:00:00Z",
      allDay: false,
      tagColor: null,
    }));

    let allowDelete = false;
    const confirmEventBlockRemoval = vi.fn(
      async (_req: MyoxusConfirmEventRemovalRequest) => allowDelete,
    );
    window.myoxusHostService.confirmEventBlockRemoval =
      confirmEventBlockRemoval;

    const noteId = insertTestNote(doc);
    const eventBlockId = doc.addBlock(
      "myoxus:event",
      { workspaceId: "ws-calendar-1", eventId: "evt-202" },
      noteId,
    );
    await flushFrame();

    const host = editor.host!;
    const blockEl = host.view.getBlock(eventBlockId);
    expect(blockEl).toBeInstanceOf(HTMLElement);
    await expect
      .poll(() =>
        blockEl!
          .querySelector<HTMLElement>('[data-testid="editor-event-card"]')
          ?.getAttribute("data-state"),
      )
      .toBe("ready");

    // Activate UIEventDispatcher deterministically across Chromium and Firefox
    // before dispatching document-level hotkeys.
    host.dispatchEvent(
      new FocusEvent("focusin", { bubbles: true, composed: true }),
    );
    host.selection.set([
      host.selection.create(BlockSelection, { blockId: eventBlockId }),
    ]);

    // First Delete is rejected by host confirmation -> block stays mounted.
    host.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Delete",
        code: "Delete",
        bubbles: true,
        composed: true,
      }),
    );
    await expect.poll(() => confirmEventBlockRemoval.mock.calls.length).toBe(1);
    expect(confirmEventBlockRemoval).toHaveBeenLastCalledWith({
      blockId: eventBlockId,
      workspaceId: "ws-calendar-1",
      eventId: "evt-202",
    });
    await flushFrame();
    expect(doc.getBlock(eventBlockId)).toBeDefined();

    // Second Delete is approved -> block is deleted from store.
    allowDelete = true;
    host.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Delete",
        code: "Delete",
        bubbles: true,
        composed: true,
      }),
    );
    await expect.poll(() => doc.getBlock(eventBlockId)).toBeUndefined();
    expect(confirmEventBlockRemoval).toHaveBeenCalledTimes(2);
  });
});
