import type { OpenSettingsRequest } from "@myoxus/desktop-api-contract";

import type { MainEventImplementations } from "../type";
import type { DocumentVersionMenuAction } from "./doc-versions";
import { applicationMenuSubjects } from "./subject";

export * from "./create";
export * from "./subject";

/**
 * Events triggered by application menu
 */
export const applicationMenuEvents = {
  onEditHistory: (
    fn: (payload: { action: "undo" | "redo"; tabId: string }) => void,
  ) => {
    const sub = applicationMenuSubjects.editHistory$.subscribe(fn);
    return () => sub.unsubscribe();
  },
  /**
   * File -> New Doc
   */
  onNewPageAction: (fn: (type: "page" | "edgeless") => void) => {
    const sub = applicationMenuSubjects.newPageAction$.subscribe(fn);
    return () => {
      sub.unsubscribe();
    };
  },
  openInSettingModal: (fn: (props: OpenSettingsRequest) => void) => {
    const sub = applicationMenuSubjects.openInSettingModal$.subscribe(fn);
    return () => {
      sub.unsubscribe();
    };
  },
  onOpenJournal: (fn: () => void) => {
    const sub = applicationMenuSubjects.openJournal$.subscribe(fn);
    return () => {
      sub.unsubscribe();
    };
  },
  onDocumentVersionAction: (
    fn: (payload: {
      action: DocumentVersionMenuAction;
      tabId: string;
      docId: string;
    }) => void,
  ) => {
    const sub = applicationMenuSubjects.documentVersionAction$.subscribe(fn);
    return () => {
      sub.unsubscribe();
    };
  },
} satisfies MainEventImplementations["applicationMenu"];
