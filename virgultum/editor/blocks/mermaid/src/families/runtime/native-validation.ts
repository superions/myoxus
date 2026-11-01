// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidFamilyRuntime } from "./contracts.js";

type Validation = {
  status: "pending" | "valid" | "invalid";
  message?: string;
  ready: Promise<void>;
};
// This bounded memo contains only grammar verdicts, never a second diagram
// model, Source writer, registry or history. Repeated GFX reads do not reparse
// through the asynchronous native runtime on every pointer movement.
const validations = new Map<string, Validation>();
const listeners = new Set<(source: string) => void>();

export function subscribeMermaidNativeValidation(
  listener: (source: string) => void,
) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function readMermaidNativeValidation(
  source: string,
  runtime: MermaidFamilyRuntime,
) {
  if (!runtime.validateSource) return undefined;
  const existing = validations.get(source);
  if (existing) return existing;
  const result: Validation = { status: "pending", ready: Promise.resolve() };
  validations.set(source, result);
  result.ready = runtime
    .validateSource(source)
    .then(
      () => {
        result.status = "valid";
      },
      (error: unknown) => {
        result.status = "invalid";
        result.message = error instanceof Error ? error.message : String(error);
      },
    )
    .then(() => {
      for (const listener of listeners) listener(source);
      // Keep in-flight revisions until settled; removing a pending entry would
      // enqueue the same parse again while a document is still rendering.
      for (const [key, entry] of validations) {
        if (validations.size <= 32) break;
        if (key !== source && entry.status !== "pending")
          validations.delete(key);
      }
    });
  return result;
}
