// SPDX-License-Identifier: AGPL-3.0-or-later
import { createIdentifier } from "@virgultum/global/di";
import type { DocMode } from "@virgultum/model";
import type { Workspace } from "@virgultum/store";
import { effect, type ReadonlySignal } from "@preact/signals-core";

/** Host-owned access and loading; the editor never infers access from cached Yjs. */
export interface DocEmbedProvider {
  /** Borrow the existing host workspace pool. Dispose when the reference changes. */
  inWorkspace?(workspaceId: string):
    | {
        access: DocEmbedProvider;
        collection: Workspace;
        dispose: () => void;
      }
    | undefined;
  /** Borrow the canonical guarded reference, following the host's existing redirects.
   * Undefined is loading, null is unavailable; native source addresses are unchanged.
   */
  openReference?(
    workspaceId: string | undefined,
    docId: string,
  ): {
    target: ReadonlySignal<
      | {
          access: DocEmbedProvider;
          collection: Workspace;
          docId: string;
        }
      | null
      | undefined
    >;
    dispose: () => void;
  };
  /** Resolve read access without loading a body or exposing cached metadata. */
  canRead(docId: string): Promise<boolean>;
  primaryMode?(docId: string): ReadonlySignal<DocMode | undefined>;
  readable(docId: string): ReadonlySignal<boolean | undefined>;
  /** Current host title projection, guarded without loading a document body. */
  referenceTitle?(docId: string): Promise<string | undefined>;
  referenceTitleSignal?(docId: string): ReadonlySignal<string | undefined>;
  /** Check read access before/after loading; reject on denial or cancellation.
   * Successful return leaves readable(docId) true for the caller's capture fence.
   */
  waitForLoaded(docId: string, signal: AbortSignal): Promise<void>;
}

export const DocEmbedProvider =
  createIdentifier<DocEmbedProvider>("DocEmbedProvider");

/** Resolve one export/peek read through the same bounded, lifetime-owned binding. */
export async function awaitDocEmbedReference(
  provider: DocEmbedProvider | null | undefined,
  docId: string,
  workspaceId?: string,
  abort: AbortSignal = AbortSignal.timeout(30_000),
) {
  abort.throwIfAborted();
  const binding = provider?.openReference?.(workspaceId, docId);
  if (!binding) return;
  let stop = () => {};
  let onAbort = () => {};
  try {
    const target = await new Promise<NonNullable<
      typeof binding.target.value
    > | null>((resolve, reject) => {
      onAbort = () => reject(abort.reason);
      abort.addEventListener("abort", onAbort, { once: true });
      stop = effect(() => {
        const value = binding.target.value;
        if (value !== undefined) resolve(value);
      });
    });
    if (!target) {
      binding.dispose();
      return;
    }
    return { ...target, dispose: binding.dispose };
  } catch (error) {
    binding.dispose();
    throw error;
  } finally {
    stop();
    abort.removeEventListener("abort", onAbort);
  }
}
