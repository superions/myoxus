import type { ReferenceInfo } from "@virgultum/core/models";
import type { OpenDocMode } from "@virgultum/core/services";
import type { EditorHost } from "@virgultum/core/runtime";
import type { Subject } from "rxjs";

export type DocLinkClickedEvent = ReferenceInfo & {
  // default is active view
  openMode?: OpenDocMode;
  event?: MouseEvent;
  host: EditorHost;
};

export type RefNodeSlots = {
  docLinkClicked: Subject<DocLinkClickedEvent>;
};
