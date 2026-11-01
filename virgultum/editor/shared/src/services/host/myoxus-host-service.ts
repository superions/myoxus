// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `MyoxusHostService` - the typed boundary between Virgultum
 * (editor core) and the Myoxus application shell.
 *
 * This interface is consumed by Virgultum features that need to
 * reach the host (Web, Electron, Mobile). It replaces the previous
 * DOM `CustomEvent` and `globalThis.currentEditor` coupling with
 * explicit, versioned service methods.
 *
 * Consumers MUST obtain the service via
 * `std.get(MyoxusHostServiceIdentifier)` from a `BlockStdScope`
 * that has the `MyoxusHostExtension` registered.
 *
 * Implementation lives in Myoxus Core
 * (`client/libs/core/src/editor/virgultum/doc-editor/myoxus-host-adapter.ts`).
 *
 * @see docs/dev/virgultum/refactor-roadmap.md §B
 */

import { createIdentifier } from "@virgultum/global/di";
import type { BlockStdScope } from "@virgultum/std";

import type {
  MyoxusCapabilitySetLike,
  MyoxusConfirmEventRemovalRequest,
  MyoxusBpmnEditorRequest,
  MyoxusBpmnEditorCloseResult,
  MyoxusOpenEventEditDialogArgs,
  MyoxusResolvedEvent,
  MyoxusResolveEventRequest,
  MyoxusTemplateVariableCapability,
  MyoxusTemplateVariableRequest,
} from "./types.js";
import { MyoxusHostCapability } from "./types.js";

/**
 * The Myoxus Host Service contract. External operations are async to allow
 * the host to perform I/O (GraphQL, navigation, dialog) without
 * blocking the editor render path. Current context/feature projections are
 * synchronous reads of host-owned state, not additional editor caches.
 */
export interface MyoxusHostService {
  /**
   * The capabilities the host binding actually supports. Consumers
   * MAY use this to branch on optional features without catching
   * `MyoxusHostBindingError`. Methods not in the set MUST throw
   * `MyoxusHostBindingError`.
   */
  readonly capabilities: ReadonlySet<MyoxusHostCapability>;

  // Event/Calendar dialogs
  openEventEditDialog(
    args: MyoxusOpenEventEditDialogArgs,
  ): Promise<string | null>;

  // Event data resolution
  resolveEventData(
    request: MyoxusResolveEventRequest,
  ): Promise<MyoxusResolvedEvent | null>;

  // Image proxy URL — already a registered store service
  //    (`ImageProxyService`); the host supplies the URL via
  //    `page.get(ImageProxyService).setImageProxyURL(...)`. The
  //    HostService does not reimplement this; the capability
  //    here is purely informational so blocks can assert "the
  //    host has set the image proxy URL" if needed.
  hasImageProxyUrl(): boolean;

  // Feature flags
  isFeatureEnabled(flag: string): boolean;
  listFeatureFlags?(): readonly string[];

  // Workspace context
  getWorkspaceId(): string;
  /** Current document template state; no metadata copy is owned by the editor. */
  isTemplateDocument(): boolean;
  /** Static variables supported by the current host application. */
  getTemplateVariableCapabilities(): readonly MyoxusTemplateVariableCapability[];
  openTemplateVariablePicker?(request: MyoxusTemplateVariableRequest): void;
  /** Capture the active native body before the host picker takes focus. */
  openBuildingBlockPicker?(std: BlockStdScope): void;
  /** Save a frozen native selection as a separate custom template source. */
  saveBuildingBlockSelection?(std: BlockStdScope): void;
  getWorkspaceMeta?(): {
    id: string;
    flavour: string;
    [key: string]: unknown;
  };

  // Event-block removal confirmation. Returns `true` if the
  //    block may delete itself, `false` if the host vetoed the
  //    removal.
  confirmEventBlockRemoval?(
    request: MyoxusConfirmEventRemovalRequest,
  ): Promise<boolean>;

  /** Open the leased workspace BPMN session for this mounted editor host. */
  openBpmnEditor?(
    request: MyoxusBpmnEditorRequest,
  ): Promise<MyoxusBpmnEditorCloseResult>;
}

export const MyoxusHostServiceIdentifier =
  createIdentifier<MyoxusHostService>("MyoxusHostService");

/**
 * Thrown when a `MyoxusHostService` method is invoked but the host
 * has not bound the corresponding capability. Replaces the silent
 * "CustomEvent was never listened to" failure mode.
 */
export class MyoxusHostBindingError extends Error {
  readonly capability: MyoxusHostCapability | string;

  constructor(capability: MyoxusHostCapability | string, detail?: string) {
    super(
      detail ??
        `MyoxusHostService is not bound or does not expose capability '${capability}'. ` +
          `The host (Core/Web/Electron) must register a MyoxusHostService via MyoxusHostExtension on the BlockStdScope.`,
    );
    this.name = "MyoxusHostBindingError";
    this.capability = capability;
  }
}

const NO_CAPABILITIES: ReadonlySet<MyoxusHostCapability> = new Set();

/**
 * Default (null) implementation. All capability-bearing methods
 * throw `MyoxusHostBindingError`. Used when no host adapter is
 * bound, e.g. in unit tests that do not exercise the host boundary.
 *
 * `MyoxusHostExtension` MUST be registered with a non-null
 * implementation in any production BlockStdScope. The presence of
 * this null binding is the primary safety net against silent
 * CustomEvent fallbacks.
 */
export class NullMyoxusHostService implements MyoxusHostService {
  readonly capabilities: ReadonlySet<MyoxusHostCapability> = NO_CAPABILITIES;

  private fail(capability: MyoxusHostCapability): never {
    throw new MyoxusHostBindingError(capability);
  }

  openEventEditDialog(
    _args: MyoxusOpenEventEditDialogArgs,
  ): Promise<string | null> {
    this.fail(MyoxusHostCapability.OpenEventEditDialog);
  }

  resolveEventData(
    _request: MyoxusResolveEventRequest,
  ): Promise<MyoxusResolvedEvent | null> {
    this.fail(MyoxusHostCapability.ResolveEventData);
  }

  hasImageProxyUrl(): boolean {
    return false;
  }

  isFeatureEnabled(_flag: string): boolean {
    return false;
  }

  getWorkspaceId(): string {
    this.fail(MyoxusHostCapability.WorkspaceContext);
  }

  isTemplateDocument(): boolean {
    return false;
  }

  getTemplateVariableCapabilities(): readonly MyoxusTemplateVariableCapability[] {
    return [];
  }

  confirmEventBlockRemoval?(
    _request: MyoxusConfirmEventRemovalRequest,
  ): Promise<boolean> {
    this.fail(MyoxusHostCapability.ConfirmEventBlockRemoval);
  }
}

/**
 * Type guard: returns true when the service actually exposes a
 * capability. Use this in lieu of `instanceof` checks because
 * `MyoxusHostService` is an interface.
 */
export function hasCapability(
  service: MyoxusHostService,
  capability: MyoxusHostCapability,
): boolean {
  return service.capabilities.has(capability);
}

/**
 * Convenience helper: returns the optional method only if the
 * capability is exposed. Lets call-sites write:
 *
 * ```ts
 * const fn = capabilityOrUndefined(host, MyoxusHostCapability.BpmnEditorSession);
 * if (fn) await fn({ ... });
 * ```
 */
export function capabilityOrUndefined<K extends keyof MyoxusHostService>(
  service: MyoxusHostService,
  capability: MyoxusHostCapability,
): MyoxusHostService[K] | undefined {
  if (!hasCapability(service, capability)) return undefined;
  // The capability has been verified above; the lookup is safe.
  return service[capabilityMap[capability] as K];
}

const capabilityMap: {
  [C in MyoxusHostCapability]: keyof MyoxusHostService;
} = {
  [MyoxusHostCapability.OpenEventEditDialog]: "openEventEditDialog",
  [MyoxusHostCapability.ResolveEventData]: "resolveEventData",
  [MyoxusHostCapability.ConfirmEventBlockRemoval]: "confirmEventBlockRemoval",
  [MyoxusHostCapability.ImageProxyUrl]: "hasImageProxyUrl",
  [MyoxusHostCapability.FeatureFlags]: "isFeatureEnabled",
  [MyoxusHostCapability.WorkspaceContext]: "getWorkspaceId",
  [MyoxusHostCapability.BpmnEditorSession]: "openBpmnEditor",
};

// Re-export the capability set type so consumers can type-narrow.
export type { MyoxusCapabilitySetLike };
