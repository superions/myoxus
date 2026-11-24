// SPDX-License-Identifier: AGPL-3.0-or-later

import { effect } from "@preact/signals-core";
import type { EventBlockModel } from "@virgultum/core/models";
import { NativeContainerBlock } from "@virgultum/core/runtime";
import {
  EditorChromeHostIdentifier,
  hasCapability,
  MyoxusHostCapability,
  MyoxusHostServiceIdentifier,
  type EditorEventReference,
} from "@virgultum/core/services";

export class EventBlockComponent extends NativeContainerBlock<EventBlockModel> {
  protected readonly blockStyles = "";

  protected mountBody() {
    this.contentEditable = "false";
    // The block can reconnect before React commits the previous portal's
    // disposal. Keep each mount's DOM children owned by that portal.
    const target = this.ownerDocument.createElement("div");
    this.append(target);
    const model = this.model;
    const host = this.std.getOptional(MyoxusHostServiceIdentifier);
    const chrome = this.std.get(EditorChromeHostIdentifier);
    const actions: EditorEventReference["host"] = {
      resolveEventData: (request) =>
        host && hasCapability(host, MyoxusHostCapability.ResolveEventData)
          ? host.resolveEventData(request)
          : Promise.resolve(null),
      openEventEditDialog: (request) =>
        host && hasCapability(host, MyoxusHostCapability.OpenEventEditDialog)
          ? host.openEventEditDialog(request)
          : Promise.resolve(null),
    };

    this.disposables.add(
      effect(() => {
        // Remount only if this foreign key or its edit grant actually changes.
        void model.props.eventId$.value;
        void model.props.workspaceId$.value;
        return chrome.mountEventReference(target, {
          model,
          readonly: this.store.readonly$.value,
          host: actions,
        });
      }),
    );
    const remove = () => {
      if (this.store.readonly) return false;
      const { workspaceId, eventId } = model.props;
      if (
        !host ||
        !hasCapability(host, MyoxusHostCapability.ConfirmEventBlockRemoval) ||
        !host.confirmEventBlockRemoval
      ) {
        this.store.deleteBlock(model);
        return true;
      }
      void host
        .confirmEventBlockRemoval({ blockId: model.id, workspaceId, eventId })
        .then((ok) => {
          if (
            ok &&
            this.isConnected &&
            !this.store.readonly &&
            this.store.getModelById(model.id) === model &&
            model.props.workspaceId === workspaceId &&
            model.props.eventId === eventId
          )
            this.store.deleteBlock(model);
        })
        .catch(console.error);
      return true;
    };
    this.bindHotKey({ Delete: remove, Backspace: remove });
    return null;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-event": EventBlockComponent;
  }
}
