// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidEditorCapabilities } from "./editor-capabilities.js";
import type { MermaidHostProjectionContext } from "./editor-capabilities.js";
import type { MermaidFamilyRuntimeResolution } from "./contracts.js";
import type { MermaidSourceLifecycleState } from "./source-lifecycle.js";

export type MermaidHostResolution = {
  readonly capabilities: MermaidEditorCapabilities | null;
  readonly pending: boolean;
  readonly pendingReason?: string;
  readonly sourceFirst: boolean;
  readonly sourceFirstReason?: string;
  readonly sourceState: MermaidSourceLifecycleState["kind"];
  readonly staleProjection: boolean;
};

/**
 * Creates the family-neutral host port without retaining an eager snapshot of
 * Std, Store, model or DOM state. Callers supply lazy accessors so a capability
 * rendered after a lifecycle transition always observes the active host.
 */
export function createMermaidHostProjectionContext(
  ports: MermaidHostProjectionContext,
): MermaidHostProjectionContext {
  return ports;
}

/**
 * The only family-neutral bridge from registry resolution into block chrome.
 * Family adapters own labels, props and callbacks; the block host only asks
 * the selected runtime for a complete capability projection.
 */
export function resolveMermaidHostResolution(
  resolution: MermaidFamilyRuntimeResolution,
  {
    sourceState = resolution.kind === "resolved"
      ? "valid"
      : resolution.kind === "source-first"
        ? "source-first"
        : resolution.kind,
    staleProjection = false,
  }: {
    readonly sourceState?: MermaidSourceLifecycleState["kind"];
    readonly staleProjection?: boolean;
  } = {},
): MermaidHostResolution {
  if (resolution.kind === "resolved") {
    return {
      capabilities: resolution.capabilities,
      pending: false,
      sourceFirst: false,
      sourceState,
      staleProjection,
    };
  }
  return {
    capabilities: null,
    pending: resolution.kind === "pending",
    pendingReason:
      resolution.kind === "pending" ? resolution.reason : undefined,
    sourceFirst:
      resolution.kind === "source-first" || resolution.kind === "empty",
    sourceFirstReason:
      resolution.kind === "source-first" ? resolution.reason : undefined,
    sourceState,
    staleProjection,
  };
}
