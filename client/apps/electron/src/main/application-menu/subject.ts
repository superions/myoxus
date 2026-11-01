import type { OpenSettingsRequest } from "@myoxus/desktop-api-contract";
import { Subject } from "rxjs";

import type { DocumentVersionMenuAction } from "./doc-versions";

export const applicationMenuSubjects = {
  editHistory$: new Subject<{ action: "undo" | "redo"; tabId: string }>(),
  newPageAction$: new Subject<"page" | "edgeless">(),
  openJournal$: new Subject<void>(),
  openInSettingModal$: new Subject<OpenSettingsRequest>(),
  documentVersionAction$: new Subject<{
    action: DocumentVersionMenuAction;
    tabId: string;
    docId: string;
  }>(),
};
