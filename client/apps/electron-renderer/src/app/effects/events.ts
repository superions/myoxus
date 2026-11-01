import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import { DocsService } from "@myoxus/core/modules/doc";
import { JournalService } from "@myoxus/core/modules/journal";
import { LifecycleService } from "@myoxus/core/modules/lifecycle";
import { WorkbenchService } from "@myoxus/core/modules/workbench";
import type {
  DesktopSettingTab,
  DesktopWorkspaceSettingTab,
} from "@myoxus/desktop-api-contract";
import { getDesktopBridge } from "@myoxus/desktop-api-contract/bridge";
import type { FrameworkProvider } from "@myoxus/infra";

import { setupRecordingEvents } from "./recording";
import { getCurrentWorkspace } from "./utils";

const desktopBridge = getDesktopBridge();
const apis = desktopBridge?.apis;
const events = desktopBridge?.events;

function isWorkspaceSettingTab(
  tab: DesktopSettingTab,
): tab is DesktopWorkspaceSettingTab {
  return tab.startsWith("workspace:");
}

export function setupEvents(frameworkProvider: FrameworkProvider) {
  // setup application lifecycle events, and emit application start event
  window.addEventListener("focus", () => {
    frameworkProvider.get(LifecycleService).applicationFocus();
  });
  frameworkProvider.get(LifecycleService).applicationStart();

  events?.applicationMenu.onEditHistory(({ action, tabId }) => {
    if (tabId !== desktopBridge?.appInfo.viewId) return;
    const target = document.activeElement ?? document.body;
    // Native menu roles bypass the editor's Yjs history. Let its existing
    // keyboard owner handle the action, retaining Chromium history for inputs.
    const handled = !target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "z",
        code: "KeyZ",
        metaKey: environment.isMacOs,
        ctrlKey: !environment.isMacOs,
        shiftKey: action === "redo",
        bubbles: true,
        cancelable: true,
        composed: true,
      }),
    );
    if (!handled) document.execCommand(action);
  });

  events?.applicationMenu.openInSettingModal(({ activeTab, scrollAnchor }) => {
    void (async () => {
      using currentWorkspace = getCurrentWorkspace(frameworkProvider);
      if (!currentWorkspace) return;
      const { workspace } = currentWorkspace;
      const workspaceDialogService = workspace.scope.get(
        WorkspaceDialogService,
      );
      // Retain the scope while awaiting its owner veto; a new settings dialog
      // must not cover the unsaved-session confirmation or open after Cancel.
      if (!(await workspaceDialogService.closeAll())) return;
      if (isWorkspaceSettingTab(activeTab)) {
        workspaceDialogService.open("workspace-settings", {
          activeTab,
          scrollAnchor,
        });
      } else {
        workspaceDialogService.open("user-settings", {
          activeTab,
          scrollAnchor,
        });
      }
    })().catch(console.error);
  });

  events?.applicationMenu.onNewPageAction((type) => {
    apis?.ui
      .isActiveTab()
      .then((isActive) => {
        if (!isActive) {
          return;
        }
        using currentWorkspace = getCurrentWorkspace(frameworkProvider);
        if (!currentWorkspace) {
          return;
        }
        const { workspace } = currentWorkspace;
        const docsService = workspace.scope.get(DocsService);

        const page = docsService.createDoc({ primaryMode: type });
        workspace.scope.get(WorkbenchService).workbench.openDoc(page.id);
      })
      .catch((err) => {
        console.error(err);
      });
  });

  events?.applicationMenu.onOpenJournal(() => {
    using currentWorkspace = getCurrentWorkspace(frameworkProvider);
    if (!currentWorkspace) {
      return;
    }
    const { workspace, dispose } = currentWorkspace;

    const workbench = workspace.scope.get(WorkbenchService).workbench;
    const journalService = workspace.scope.get(JournalService);
    const docId = journalService.ensureJournalByDate(new Date()).id;
    workbench.openDoc(docId);

    dispose();
  });

  events?.applicationMenu.onDocumentVersionAction((payload) => {
    apis?.ui
      .isActiveTab()
      .then((isActive) => {
        if (!isActive) return;
        using currentWorkspace = getCurrentWorkspace(frameworkProvider);
        if (!currentWorkspace) return;

        const { workspace, dispose } = currentWorkspace;
        const workbench = workspace.scope.get(WorkbenchService).workbench;
        const activeView = workbench.activeView$.value;
        const activeDocId = activeView.location$.value.pathname
          .split("/")
          .find(Boolean);
        if (!activeDocId || activeDocId !== payload.docId) {
          dispose();
          return;
        }

        activeView.showTool("activity");
        window.dispatchEvent(
          new CustomEvent("myoxus:document-version-menu-action", {
            detail: payload,
          }),
        );
        dispose();
      })
      .catch((err) => {
        console.error(err);
      });
  });

  // DESKTOP-01-C: calendar reminder notification click → navigate to journal date
  events?.ui?.onCalendarReminderClick(({ startDate }) => {
    using currentWorkspace = getCurrentWorkspace(frameworkProvider);
    if (!currentWorkspace) {
      return;
    }
    const { workspace, dispose } = currentWorkspace;
    const workbench = workspace.scope.get(WorkbenchService).workbench;
    workbench.open(`/journals?date=${startDate}`, { at: "active" });
    dispose();
  });

  setupRecordingEvents(frameworkProvider);
}
