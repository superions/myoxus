// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BpmnSourceRevisionProps } from "@virgultum/model";
import { LifeCycleWatcher } from "@virgultum/std";
import type { TransformerMiddleware } from "@virgultum/store";
import { cloneBpmnSourceRevisionSnapshot } from "./source-revisions.js";

/** Native Page/Edgeless snapshots retain every head and ancestry, but each paste
 * remaps their identities. Cached preview provenance stays unchanged: a copied
 * last-good image is stale until the shared session produces the new head's SVG. */
export const remapBpmnClipboardRevisions: TransformerMiddleware = ({
  slots,
}) => {
  const subscription = slots.beforeImport.subscribe((event) => {
    if (event.type !== "block" || event.snapshot.flavour !== "myoxus:bpmn")
      return;
    try {
      Object.assign(
        event.snapshot.props,
        cloneBpmnSourceRevisionSnapshot(
          event.snapshot.props as BpmnSourceRevisionProps,
        ),
      );
    } catch {
      // Malformed snapshots remain recoverable as-is. The passive block exposes
      // the invalid state; copying must not discard source or select a winner.
    }
  });
  return () => subscription.unsubscribe();
};

/** Register only the shared snapshot transform; native owners handle clipboard
 * events, mixed selections, assets and deletion in both modes. */
export class BpmnClipboardController extends LifeCycleWatcher {
  static override key = "myoxus-bpmn-clipboard";
  override mounted() {
    this.std.clipboard.use(remapBpmnClipboardRevisions);
  }
  override unmounted() {
    this.std.clipboard.unuse(remapBpmnClipboardRevisions);
  }
}
