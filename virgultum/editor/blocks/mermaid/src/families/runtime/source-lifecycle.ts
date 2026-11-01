// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidFamilyRuntimeResolution } from "./contracts.js";
import { resolveMermaidFamilyRuntime } from "./registry.js";

export type MermaidSourceLifecycleState = {
  readonly canReconcileProjection: boolean;
  readonly canRetainAsLastValid: boolean;
  readonly kind: "empty" | "invalid" | "pending" | "source-first" | "valid";
  readonly reason?: string;
  readonly resolution: MermaidFamilyRuntimeResolution;
};

/**
 * The family-neutral source lifecycle decision used by source persistence,
 * owner synchronization and the host shell. A source may mutate while
 * empty or invalid, but only a fully resolved runtime may replace its last
 * valid projection.
 */
export function resolveMermaidSourceLifecycle(
  source: string,
  previousStructuredModel?: unknown,
): MermaidSourceLifecycleState {
  const resolution = resolveMermaidFamilyRuntime(
    source,
    null,
    previousStructuredModel,
  );
  if (resolution.kind === "resolved") {
    const hasErrors = resolution.diagnostics.some(
      ({ severity }) => severity === "error",
    );
    return {
      canReconcileProjection: !resolution.nativeValidationPending,
      canRetainAsLastValid: !hasErrors && !resolution.nativeValidationPending,
      kind: hasErrors
        ? "invalid"
        : resolution.nativeValidationPending
          ? "pending"
          : "valid",
      resolution,
    };
  }
  if (resolution.kind === "empty") {
    return {
      canReconcileProjection: false,
      canRetainAsLastValid: false,
      kind: "empty",
      resolution,
    };
  }
  if (resolution.kind === "pending") {
    return {
      canReconcileProjection: false,
      canRetainAsLastValid: false,
      kind: "pending",
      reason: resolution.reason,
      resolution,
    };
  }
  const invalid =
    resolution.diagramType === "unknown" ||
    resolution.diagnostics.some(({ severity }) => severity === "error");
  return {
    canReconcileProjection: false,
    canRetainAsLastValid: !invalid,
    kind: invalid ? "invalid" : "source-first",
    reason: resolution.reason,
    resolution,
  };
}
