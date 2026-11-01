// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `MyoxusHostExtension` - the `BlockStdScope` extension that wires
 * a `MyoxusHostService` implementation into the editor runtime.
 *
 * The host (Core/Web/Electron) constructs a concrete service
 * adapter and registers it via this extension when bootstrapping a
 * `BlockStdScope`. Virgultum features then consume it via
 * `std.get(MyoxusHostServiceIdentifier)`.
 *
 * @see docs/dev/virgultum/refactor-roadmap.md §B
 */

import type { ExtensionType } from "@virgultum/store";

import {
  type MyoxusHostService,
  MyoxusHostServiceIdentifier,
} from "./myoxus-host-service.js";
import type { MyoxusCapabilitySetLike } from "./types.js";

/**
 * Construct a `BlockStdScope` extension that publishes
 * `service` under the `MyoxusHostServiceIdentifier` key.
 *
 * The host MUST register exactly one such extension per editor
 * scope. Registering a second one will overwrite the first and is
 * considered a bug; the binding is intentional and the host should
 * migrate a scope when the host service changes (e.g. workspace
 * switch).
 *
 * @example
 *   const hostService = createMyoxusHostService({
 *     openEventEditDialog: async () => null,
 *     resolveEventData: async () => null,
 *     hasImageProxyUrl: () => false,
 *     isFeatureEnabled: () => false,
 *     getWorkspaceId: () => workspaceService.workspace.id,
 *     capabilities: [MyoxusHostCapability.WorkspaceContext],
 *   });
 *   const scope = new BlockStdScope({
 *     store,
 *     extensions: [MyoxusHostExtension(hostService)],
 *   });
 */
export function MyoxusHostExtension(service: MyoxusHostService): ExtensionType {
  if (!service) {
    throw new Error(
      "MyoxusHostExtension: service must not be nullish. Use NullMyoxusHostService explicitly if you need a stub.",
    );
  }
  return {
    setup: (di) => {
      di.addImpl(MyoxusHostServiceIdentifier, () => service);
    },
  };
}

/**
 * Helper for hosts: constructs a `MyoxusHostService` from a
 * concrete implementation and an explicit capability set. Listing a capability
 * does not synthesize a missing method; the host owns that correspondence.
 */
export function createMyoxusHostService(
  partial: Omit<Partial<MyoxusHostService>, "capabilities"> & {
    capabilities: MyoxusCapabilitySetLike;
    openEventEditDialog: MyoxusHostService["openEventEditDialog"];
    resolveEventData: MyoxusHostService["resolveEventData"];
    hasImageProxyUrl: MyoxusHostService["hasImageProxyUrl"];
    isFeatureEnabled: MyoxusHostService["isFeatureEnabled"];
    getWorkspaceId: MyoxusHostService["getWorkspaceId"];
  },
): MyoxusHostService {
  const { capabilities: rawCapabilities, ...rest } = partial;
  const capabilitySet = new Set(rawCapabilities);
  return {
    // Hosts without a template catalogue must never expose template authoring.
    isTemplateDocument: () => false,
    getTemplateVariableCapabilities: () => [],
    ...rest,
    capabilities: capabilitySet,
  };
}
