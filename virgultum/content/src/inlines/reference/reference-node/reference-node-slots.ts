import { createIdentifier } from "@virgultum/core/primitives/di";
import type { ReferenceInfo } from "@virgultum/core/models";
import type { OpenDocMode } from "@virgultum/core/services";
import type { EditorHost } from "@virgultum/core/runtime";
import type { ExtensionType } from "@virgultum/core/store";
import { Subject } from "rxjs";

export type DocLinkClickedEvent = ReferenceInfo & {
  // default is active view
  openMode?: OpenDocMode;
  event?: MouseEvent;
  host: EditorHost;
};

export type RefNodeSlots = {
  docLinkClicked: Subject<DocLinkClickedEvent>;
};

export const RefNodeSlotsProvider =
  createIdentifier<RefNodeSlots>("MyoxusRefNodeSlots");

const slots: RefNodeSlots = {
  docLinkClicked: new Subject(),
};

export const RefNodeSlotsExtension: ExtensionType = {
  setup: (di) => {
    di.addImpl(RefNodeSlotsProvider, () => slots);
  },
};
