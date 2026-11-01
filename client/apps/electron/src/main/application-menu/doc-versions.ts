import { Menu, type MenuItemConstructorOptions } from "electron";

import type { TabViewsMetaSchema } from "../shared-state-schema";
import { getTabViewsMeta } from "../windows-manager";
import { applicationMenuSubjects } from "./subject";

export type DocumentVersionMenuAction =
  "new-version" | "show-sidebar" | "compare-versions" | "restore-version";

export interface DocumentVersionMenuContext {
  tabId: string;
  docId: string;
}

export const DOCUMENT_VERSION_MENU_ITEM_IDS = [
  "myoxus:document-version:new-version",
  "myoxus:document-version:show-sidebar",
  "myoxus:document-version:compare-versions",
  "myoxus:document-version:restore-version",
] as const;

const RESERVED_WORKBENCH_PATHS = new Set([
  "all",
  "collection",
  "collections",
  "tag",
  "trash",
  "settings",
  "workspaces",
  "chat",
]);

function docIdFromPathname(pathname: string | undefined): string | null {
  const firstSegment = pathname?.split("/").find(Boolean);
  if (!firstSegment || RESERVED_WORKBENCH_PATHS.has(firstSegment)) {
    return null;
  }
  return firstSegment;
}

export function getDocumentVersionMenuContextFromMeta(
  meta: TabViewsMetaSchema,
): DocumentVersionMenuContext | null {
  const activeWorkbenchId = meta.activeWorkbenchId;
  if (!activeWorkbenchId) return null;

  const workbench = meta.workbenches.find(
    (item) => item.id === activeWorkbenchId,
  );
  const activeView = workbench?.views.at(workbench.activeViewIndex);
  const docId = docIdFromPathname(activeView?.path?.pathname);
  if (!workbench || !docId) return null;

  return {
    tabId: workbench.id,
    docId,
  };
}

export function getActiveDocumentVersionMenuContext(): DocumentVersionMenuContext | null {
  return getDocumentVersionMenuContextFromMeta(getTabViewsMeta());
}

function dispatchDocumentVersionAction(action: DocumentVersionMenuAction) {
  const context = getActiveDocumentVersionMenuContext();
  if (!context) return;
  applicationMenuSubjects.documentVersionAction$.next({ action, ...context });
}

export function createDocumentVersionSubmenu(): MenuItemConstructorOptions {
  const enabled = getActiveDocumentVersionMenuContext() !== null;
  return {
    label: "Versions",
    submenu: [
      {
        id: DOCUMENT_VERSION_MENU_ITEM_IDS[0],
        label: "New Version",
        enabled,
        click: () => dispatchDocumentVersionAction("new-version"),
      },
      {
        id: DOCUMENT_VERSION_MENU_ITEM_IDS[1],
        label: "Show Versions Sidebar",
        accelerator: "CommandOrControl+Alt+V",
        enabled,
        click: () => dispatchDocumentVersionAction("show-sidebar"),
      },
      { type: "separator" },
      {
        id: DOCUMENT_VERSION_MENU_ITEM_IDS[2],
        label: "Compare Versions",
        enabled,
        click: () => dispatchDocumentVersionAction("compare-versions"),
      },
      {
        id: DOCUMENT_VERSION_MENU_ITEM_IDS[3],
        label: "Restore Version",
        enabled,
        click: () => dispatchDocumentVersionAction("restore-version"),
      },
    ],
  };
}

export function refreshDocumentVersionMenuState(
  menu = Menu.getApplicationMenu(),
) {
  const enabled = getActiveDocumentVersionMenuContext() !== null;
  for (const id of DOCUMENT_VERSION_MENU_ITEM_IDS) {
    const item = menu?.getMenuItemById(id);
    if (item) item.enabled = enabled;
  }
}
