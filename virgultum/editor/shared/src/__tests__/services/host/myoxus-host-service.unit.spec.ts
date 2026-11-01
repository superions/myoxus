// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Contract tests for `MyoxusHostService`.
 *
 * These tests pin the typed boundary between Virgultum and the
 * Myoxus application shell. They MUST stay green; if a host
 * contract changes, the change has to happen in the same commit as
 * the matching consumer/producer migration.
 *
 * These tests cover binding, capability lookup and the unbound failure path.
 *
 * @see docs/dev/virgultum/refactor-roadmap.md §B (P-VIRG-ARCH-B-01)
 */

import type { Container } from "@virgultum/global/di";
import { describe, expect, it, vi } from "vitest";

import {
  capabilityOrUndefined,
  createMyoxusHostService,
  hasCapability,
  MyoxusHostBindingError,
  MyoxusHostExtension,
  MyoxusHostServiceIdentifier,
  NullMyoxusHostService,
} from "../../../services/host/index.js";
import { MyoxusHostCapability } from "../../../services/host/types.js";

/**
 * Minimal DI container stub. We only need `addImpl` for the
 * MyoxusHostExtension contract test; we record all bindings and
 * provide a `get` that retrieves them.
 */
type Binding = {
  identifier: unknown;
  factory: (provider: unknown) => unknown;
};

function makeContainer(): Container & { __bindings: Map<unknown, Binding> } {
  const bindings = new Map<unknown, Binding>();
  const container = {
    __bindings: bindings,
    addImpl: (identifier: unknown, factory: unknown) => {
      bindings.set(identifier, {
        identifier,
        factory: factory as Binding["factory"],
      });
    },
  };
  return container as unknown as Container & { __bindings: typeof bindings };
}

describe("P-VIRG-ARCH-B-01: MyoxusHostService contract", () => {
  describe("NullMyoxusHostService", () => {
    it("advertises an empty capability set", () => {
      const nullService = new NullMyoxusHostService();
      expect(nullService.capabilities.size).toBe(0);
      expect(
        hasCapability(nullService, MyoxusHostCapability.OpenEventEditDialog),
      ).toBe(false);
    });

    it("throws MyoxusHostBindingError on every capability-bearing call", () => {
      const nullService = new NullMyoxusHostService();
      expect(() =>
        nullService.openEventEditDialog({ eventId: "ev-1" }),
      ).toThrow(MyoxusHostBindingError);
      expect(() =>
        nullService.resolveEventData({ eventId: "ev-1", workspaceId: "ws-1" }),
      ).toThrow(MyoxusHostBindingError);
      expect(() => nullService.getWorkspaceId()).toThrow(
        MyoxusHostBindingError,
      );
    });

    it("MyoxusHostBindingError carries the capability name", async () => {
      const nullService = new NullMyoxusHostService();
      try {
        await nullService.openEventEditDialog({ eventId: "x" });
        throw new Error("expected openEventEditDialog to throw");
      } catch (e) {
        expect(e).toBeInstanceOf(MyoxusHostBindingError);
        expect((e as MyoxusHostBindingError).capability).toBe(
          MyoxusHostCapability.OpenEventEditDialog,
        );
      }
    });

    it("reports no image proxy URL", () => {
      const nullService = new NullMyoxusHostService();
      expect(nullService.hasImageProxyUrl()).toBe(false);
    });

    it("reports no feature flag enabled", () => {
      const nullService = new NullMyoxusHostService();
      expect(nullService.isFeatureEnabled("enable_anything")).toBe(false);
    });
  });

  describe("MyoxusHostExtension", () => {
    it("publishes the host service under MyoxusHostServiceIdentifier", () => {
      const container = makeContainer();
      const service = createMyoxusHostService({
        capabilities: [MyoxusHostCapability.OpenEventEditDialog],
        openEventEditDialog: async () => null,
        resolveEventData: async () => null,
        hasImageProxyUrl: () => false,
        isFeatureEnabled: () => false,
        getWorkspaceId: () => "ws-1",
      });
      const ext = MyoxusHostExtension(service);
      ext.setup!(container);
      expect(container.__bindings.has(MyoxusHostServiceIdentifier)).toBe(true);
      const binding = container.__bindings.get(MyoxusHostServiceIdentifier)!;
      expect(binding.factory(undefined)).toBe(service);
    });

    it("throws when the host binds a nullish service", () => {
      expect(() => MyoxusHostExtension(null as never)).toThrow(
        /service must not be nullish/,
      );
      expect(() => MyoxusHostExtension(undefined as never)).toThrow(
        /service must not be nullish/,
      );
    });
  });

  describe("createMyoxusHostService", () => {
    it("captures the capabilities argument as a ReadonlySet", () => {
      const service = createMyoxusHostService({
        capabilities: [
          MyoxusHostCapability.OpenEventEditDialog,
          MyoxusHostCapability.FeatureFlags,
        ],
        openEventEditDialog: async () => null,
        resolveEventData: async () => null,
        hasImageProxyUrl: () => false,
        isFeatureEnabled: () => false,
        getWorkspaceId: () => "ws-1",
      });
      expect(
        hasCapability(service, MyoxusHostCapability.OpenEventEditDialog),
      ).toBe(true);
      expect(hasCapability(service, MyoxusHostCapability.FeatureFlags)).toBe(
        true,
      );
      expect(
        hasCapability(service, MyoxusHostCapability.BpmnEditorSession),
      ).toBe(false);
    });

    it("preserves the original method references on the service object", async () => {
      const openEventEditDialog = vi.fn().mockResolvedValue(null);
      const service = createMyoxusHostService({
        capabilities: [MyoxusHostCapability.OpenEventEditDialog],
        openEventEditDialog,
        resolveEventData: async () => null,
        hasImageProxyUrl: () => false,
        isFeatureEnabled: () => false,
        getWorkspaceId: () => "ws-1",
      });
      await service.openEventEditDialog({ eventId: "ev-1" });
      expect(openEventEditDialog).toHaveBeenCalledWith({ eventId: "ev-1" });
    });

    it("accepts an existing ReadonlySet as capabilities argument", () => {
      const caps: ReadonlySet<MyoxusHostCapability> = new Set([
        MyoxusHostCapability.WorkspaceContext,
      ]);
      const service = createMyoxusHostService({
        capabilities: caps,
        openEventEditDialog: async () => null,
        resolveEventData: async () => null,
        hasImageProxyUrl: () => false,
        isFeatureEnabled: () => false,
        getWorkspaceId: () => "ws-1",
      });
      expect(
        hasCapability(service, MyoxusHostCapability.WorkspaceContext),
      ).toBe(true);
    });
  });

  describe("hasCapability / capabilityOrUndefined", () => {
    it("hasCapability reflects the capability set", () => {
      const service = createMyoxusHostService({
        capabilities: [MyoxusHostCapability.WorkspaceContext],
        openEventEditDialog: async () => null,
        resolveEventData: async () => null,
        hasImageProxyUrl: () => false,
        isFeatureEnabled: () => false,
        getWorkspaceId: () => "ws-1",
      });
      expect(
        hasCapability(service, MyoxusHostCapability.WorkspaceContext),
      ).toBe(true);
      expect(
        hasCapability(service, MyoxusHostCapability.OpenEventEditDialog),
      ).toBe(false);
    });

    it("capabilityOrUndefined returns the bound method when capability is exposed", () => {
      const openEventEditDialog = vi.fn();
      const service = createMyoxusHostService({
        capabilities: [MyoxusHostCapability.OpenEventEditDialog],
        openEventEditDialog,
        resolveEventData: async () => null,
        hasImageProxyUrl: () => false,
        isFeatureEnabled: () => false,
        getWorkspaceId: () => "ws-1",
      });
      expect(
        capabilityOrUndefined(
          service,
          MyoxusHostCapability.OpenEventEditDialog,
        ),
      ).toBe(openEventEditDialog);
    });

    it("capabilityOrUndefined returns undefined for unexposed capabilities", () => {
      const service = createMyoxusHostService({
        capabilities: [MyoxusHostCapability.WorkspaceContext],
        openEventEditDialog: async () => null,
        resolveEventData: async () => null,
        hasImageProxyUrl: () => false,
        isFeatureEnabled: () => false,
        getWorkspaceId: () => "ws-1",
      });
      expect(
        capabilityOrUndefined(service, MyoxusHostCapability.BpmnEditorSession),
      ).toBeUndefined();
      expect(
        capabilityOrUndefined(
          service,
          MyoxusHostCapability.OpenEventEditDialog,
        ),
      ).toBeUndefined();
    });
  });
});
