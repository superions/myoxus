import { createIdentifier } from "@virgultum/global/di";
import type { ReferenceInfo } from "@virgultum/model";
import type { OpenDocMode } from "@virgultum/shared/services";
import type { EditorHost } from "@virgultum/std";
import type { ExtensionType } from "@virgultum/store";
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
