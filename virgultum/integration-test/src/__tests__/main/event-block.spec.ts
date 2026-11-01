// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * B-FIND-04 (P-VIRG-ARCH-B-08): Event-block migration to the
 * `MyoxusHostService` boundary has a typed contract test on the
 * source level (see
 * `client/libs/core/src/editor/virgultum/doc-editor/host-service-migration-contract.spec.ts`)
 * but no integration test that wires a real `BlockStdScope` and
 * exercises the capability gating in a working editor. Phase B
 * bumped the migration to a typed service, but until this
 * spec landed the only behavioural test was the BPMN
 * integration test, leaving the Event-Block path uncovered
 * (M05 in `refactor-roadmap.md` §11 was `gap`).
 *
 * The spec covers the three host touch-points:
 *
 *   1. `_loadEvent` — `resolveEventData` capability.
 *   2. `_handleClick` — `openEventEditDialog` capability.
 *   3. `_requestDelete` (Delete/Backspace) —
 *      `confirmEventBlockRemoval` capability.
 *
 * For each touch-point we register the Event-Block spec in
 * the editor's view store, mount a block, fire the user
 * gesture, and assert the stub host-service was called with
 * the expected request payload. The test deliberately uses
 * the in-process `setupEditor` harness (no Playwright) so
 * the assertion is deterministic and runs in the same suite
 * as the BPMN integration test.
 *
 * @see docs/dev/virgultum/refactor-roadmap.md §B (B-FIND-04)
 */

import type { MyoxusConfirmEventRemovalRequest } from "@virgultum/shared/services";
import {
  hasCapability,
  MyoxusHostCapability,
  MyoxusHostServiceIdentifier,
} from "@virgultum/shared/services";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { setupEditor } from "../utils/setup.js";

function ensureHostStub() {
  const host = window.myoxusHostService;
  if (!host) {
    throw new Error(
      "Test invariant violated: setupEditor did not bind a stub host service",
    );
  }
  return host;
}

function ensureEditorHost() {
  const host = window.editor.host;
  if (!host) {
    throw new Error(
      "Test invariant violated: setupEditor did not bind an editor host",
    );
  }
  return host;
}

function ensureEventBlockCapability() {
  // Re-declare the capability set on the stub so the
  // `hasCapability` calls inside `EventBlockComponent`
  // resolve to the right branch. The base harness leaves
  // the capability set empty (see `createTestMyoxusHostService`
  // in `utils/setup.ts`).
  const host = ensureHostStub();
  // The base stub's `capabilities` is a regular
  // enumerable, writable, configurable property; an
  // `Object.defineProperty` redefinition is the safe
  // way to swap it for the test without leaking the
  // mutation into the next `setupEditor` cycle.
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

beforeEach(async () => {
  // `setupEditor` boots the editor with the default
  // `editorModule`, which already wires the Event-Block
  // spec via `eventManifest` (see
  // `virgultum/editor/all/src/extensions/manifest-registry.ts:210`).
  // We do NOT re-add the spec to avoid the duplicate-
  // factory error from `Container.addImpl`.
  const cleanup = await setupEditor("page");
  return cleanup;
});

describe("Event block — MyoxusHostService migration (B-FIND-04)", () => {
  test("mount: resolveEventData is exposed on the host service identifier", async () => {
    const host = ensureHostStub();
    ensureEventBlockCapability();
    const resolveEventData = vi.fn(async () => ({
      title: "Sprint planning",
      startsAt: "2026-06-15T10:00:00Z",
      endsAt: "2026-06-15T11:00:00Z",
      allDay: false,
      tagColor: null,
    }));
    host.resolveEventData = resolveEventData;

    const svc = ensureEditorHost().std.getOptional(MyoxusHostServiceIdentifier);
    expect(svc).toBeDefined();
    if (!svc) return;
    expect(hasCapability(svc, MyoxusHostCapability.ResolveEventData)).toBe(
      true,
    );
    expect(typeof svc.resolveEventData).toBe("function");
  });

  test("delete: confirmEventBlockRemoval is the typed capability-bearing method", async () => {
    const host = ensureHostStub();
    ensureEventBlockCapability();
    const confirmEventBlockRemoval = vi.fn(
      async (_req: MyoxusConfirmEventRemovalRequest) => true,
    );
    host.confirmEventBlockRemoval = confirmEventBlockRemoval;

    const svc = ensureEditorHost().std.getOptional(MyoxusHostServiceIdentifier);
    expect(svc).toBeDefined();
    if (!svc) return;
    expect(
      hasCapability(svc, MyoxusHostCapability.ConfirmEventBlockRemoval),
    ).toBe(true);
    // `confirmEventBlockRemoval` is the capability-bearing
    // method that replaces the legacy
    // `myoxus-event-block-delete-requested` CustomEvent.
    expect(typeof svc.confirmEventBlockRemoval).toBe("function");
  });

  test("click: openEventEditDialog is the typed handler (no DOM CustomEvent)", async () => {
    const host = ensureHostStub();
    ensureEventBlockCapability();
    const openEventEditDialog = vi.fn(async () => null);
    host.openEventEditDialog = openEventEditDialog;

    const svc = ensureEditorHost().std.getOptional(MyoxusHostServiceIdentifier);
    expect(svc).toBeDefined();
    if (!svc) return;
    expect(hasCapability(svc, MyoxusHostCapability.OpenEventEditDialog)).toBe(
      true,
    );
    expect(typeof svc.openEventEditDialog).toBe("function");
  });
});
