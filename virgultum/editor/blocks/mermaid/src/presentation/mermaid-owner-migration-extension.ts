// SPDX-License-Identifier: AGPL-3.0-or-later

import { effect } from "@preact/signals-core";
import { StoreExtension } from "@virgultum/store";

import { migrateLinkedMermaidOwners } from "./migrate-linked-owners.js";

export class MermaidOwnerMigrationExtension extends StoreExtension {
  static override readonly key = "myoxus-mermaid-owner-migration";

  private disposeReadonlyEffect: (() => void) | null = null;
  private migrationQueued = false;
  private isDisposed = false;

  migrate() {
    if (this.migrationQueued || this.isDisposed) return;
    this.migrationQueued = true;
    // Permission and Lit effects may invoke us inside a signal batch. Writing
    // Yjs object props there defers their echo until the synchronization mutex
    // has released and repeatedly recreates the same object. Migrate after the
    // current reactive turn, coalescing host and permission notifications.
    queueMicrotask(() => {
      this.migrationQueued = false;
      if (!this.isDisposed) migrateLinkedMermaidOwners(this.store);
    });
  }

  override loaded() {
    this.isDisposed = false;
    this.disposeReadonlyEffect?.();
    this.disposeReadonlyEffect = effect(() => {
      if (!this.store.readonly$.value) this.migrate();
    });
  }

  override disposed() {
    this.isDisposed = true;
    this.disposeReadonlyEffect?.();
    this.disposeReadonlyEffect = null;
  }
}
