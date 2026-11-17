// SPDX-License-Identifier: AGPL-3.0-or-later

import { effect } from "@preact/signals-core";
import { StoreExtension } from "@virgultum/core/store";

export class MermaidOwnerMigrationExtension extends StoreExtension {
  static override readonly key = "myoxus-mermaid-owner-migration";

  private disposeReadonlyEffect: (() => void) | null = null;
  private migrationTask: Promise<void> | null = null;
  private migrationRequested = false;
  private isDisposed = false;
  private generation = 0;

  /** Coalesce legacy adoption and let mounted owners resume after it completes. */
  migrate(): Promise<void> {
    if (this.isDisposed) return Promise.resolve();
    this.migrationRequested = true;
    if (this.migrationTask) return this.migrationTask;
    // Permission and Lit effects may invoke us inside a signal batch. Writing
    // Yjs object props there defers their echo until the synchronization mutex
    // has released and repeatedly recreates the same object. Migrate after the
    // current reactive turn, coalescing host and permission notifications.
    const generation = this.generation;
    const completion = Promise.withResolvers<void>();
    const runPass = async () => {
      if (
        this.isDisposed ||
        generation !== this.generation ||
        this.store.readonly ||
        !this.store.getModelsByFlavour("myoxus:mermaid").some((model) => {
          const reference = model.yBlock.get("prop:reference");
          return typeof reference === "string" && reference.length > 0;
        })
      )
        return;
      // Data-only stores without legacy owners must stay view-free after settling.
      // This is only a demand check; the existing planner inventories live state.
      // Keep one migration implementation and inventory live state after loading.
      const { migrateLinkedMermaidOwners } =
        await import("./migrate-linked-owners.js");
      if (
        !this.isDisposed &&
        generation === this.generation &&
        !this.store.readonly
      ) {
        migrateLinkedMermaidOwners(this.store);
      }
    };
    const clearTask = () => {
      // An outgoing life must not clear a later load's queued request.
      if (generation === this.generation) {
        this.migrationTask = null;
        this.migrationRequested = false;
      }
    };
    this.migrationTask = completion.promise;
    queueMicrotask(async () => {
      try {
        while (
          !this.isDisposed &&
          generation === this.generation &&
          this.migrationRequested
        ) {
          this.migrationRequested = false;
          // Even a skipped readonly pass yields to queued writable notifications.
          // They join this completion and must drain before the host resumes.
          await runPass();
        }
      } catch (error) {
        clearTask();
        completion.reject(error);
        return;
      }
      // Clear and resolve in one turn: a later finally reaction leaves a gap
      // where a request could join a worker that has already stopped draining.
      clearTask();
      completion.resolve();
    });
    return completion.promise;
  }

  override loaded() {
    this.isDisposed = false;
    this.generation++;
    this.migrationTask = null;
    this.migrationRequested = false;
    this.disposeReadonlyEffect?.();
    this.disposeReadonlyEffect = effect(() => {
      if (!this.store.readonly$.value) this.migrate();
    });
  }

  override disposed() {
    this.isDisposed = true;
    this.generation++;
    this.migrationTask = null;
    this.migrationRequested = false;
    this.disposeReadonlyEffect?.();
    this.disposeReadonlyEffect = null;
  }
}
