import type { ReferenceInfo } from "@virgultum/model";
import type { OpenDocMode } from "@virgultum/shared/services";
import type { EditorHost } from "@virgultum/std";
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
