import { LiveData, Service } from "@myoxus/infra";
import { nanoid } from "nanoid";

import type { WorkspaceService } from "../../workspace";
import type { DesktopApiService } from "../../desktop-api";
import type { PeekViewService } from "../../peek-view";
import type { WorkbenchService } from "../../workbench";

/**
 * Synchronize pane state and participate in Main-owned destructive close.
 */
export class DesktopStateSynchronizer extends Service {
  constructor(
    private readonly workbenchService: WorkbenchService,
    private readonly electronApi: DesktopApiService,
    private readonly peekViewService: PeekViewService,
    private readonly workspaceService: WorkspaceService,
  ) {
    super();
    this.startSync();
  }

  startSync = () => {
    if (!BUILD_CONFIG.isElectron) {
      return;
    }

    const workbench = this.workbenchService.workbench;
    const appInfo = this.electronApi.appInfo;

    // Use the existing Main/preload transport. The renderer owns its public
    // pane/dialog decision; Main correlates sender + participant + request and
    // cannot treat silence or a disposed workspace as permission to destroy it.
    const participantId = nanoid();
    let disposed = false;
    const removeCloseRequest = this.electronApi.events.ui.onCloseRequest(
      (request) => {
        if (request.participantId !== participantId) return;
        void (async () => {
          let allowed = false;
          try {
            allowed = await workbench.requestCloseGuards();
          } finally {
            await this.electronApi.handler.ui.answerCloseRequest(
              request.requestId,
              participantId,
              allowed && !disposed,
            );
          }
        })().catch(console.error);
      },
    );
    const registration = this.electronApi.handler.ui.setCloseParticipant(
      participantId,
      true,
    );
    void registration
      .then((registered) => {
        if (!registered && !disposed)
          console.error("Desktop close participant registration refused");
      })
      .catch(console.error);
    this.disposables.push(() => {
      disposed = true;
      removeCloseRequest();
      void registration
        .then((registered) => {
          return registered
            ? this.electronApi.handler.ui.setCloseParticipant(
                participantId,
                false,
              )
            : false;
        })
        .catch(console.error);
    });

    this.disposables.push(
      this.electronApi.events.ui.onTabAction((event) => {
        if (
          event.type === "open-in-split-view" &&
          event.payload.tabId === appInfo?.viewId
        ) {
          workbench.openAll({
            at: "beside",
            show: false,
          });
        }

        if (
          event.type === "separate-view" &&
          event.payload.tabId === appInfo?.viewId
        ) {
          const view = workbench.viewAt(event.payload.viewIndex);
          if (view) {
            workbench.close(view);
          }
        }

        if (
          event.type === "activate-view" &&
          event.payload.tabId === appInfo?.viewId
        ) {
          workbench.active(event.payload.viewIndex);
        }
      }),
    );

    this.disposables.push(
      this.electronApi.events.ui.onCloseView(() => {
        (async () => {
          if (await this.electronApi.handler.ui.isActiveTab()) {
            // close current view. stop if any one is successful
            // 1. peek view
            // 2. split view
            // 3. tab
            // 4. otherwise, hide the window
            if (this.peekViewService.peekView.show$.value?.value) {
              this.peekViewService.peekView.close();
            } else if (workbench.views$.value.length > 1) {
              workbench.close(workbench.activeView$.value);
            } else {
              const tabs = await this.electronApi.handler.ui.getTabsStatus();
              if (tabs.length > 1) {
                await this.electronApi.handler.ui.closeTab();
              } else {
                await this.electronApi.handler.ui.handleHideApp();
              }
            }
          }
        })().catch(console.error);
      }),
    );

    this.disposables.push(
      this.electronApi.events.ui.onToggleRightSidebar((tabId) => {
        if (tabId === appInfo?.viewId) {
          workbench.setContextPanelOpen(!workbench.contextPanelOpen$.value);
        }
      }),
    );

    this.disposables.push(
      this.electronApi.events.ui.onTabGoToRequest((opts) => {
        if (opts.tabId === appInfo?.viewId) {
          this.workbenchService.workbench.open(opts.to);
        }
      }),
    );

    // sync workbench state with main process
    // also fill tab view meta with title & moduleName
    const viewsSub = LiveData.computed((get) => {
      return get(workbench.views$).map((view) => {
        const location = get(view.location$);
        return {
          id: view.id,
          title: get(view.title$),
          iconName: get(view.icon$),
          path: {
            pathname: location.pathname,
            search: location.search,
            hash: location.hash,
          },
        };
      });
    }).subscribe((views) => {
      if (!appInfo?.viewId) {
        return;
      }

      this.electronApi.handler.ui
        .updateWorkbenchMeta(appInfo.viewId, {
          views,
        })
        .catch(console.error);
    });

    const activeViewIndexSub = workbench.activeViewIndex$.subscribe(
      (activeViewIndex) => {
        if (!appInfo?.viewId) {
          return;
        }

        this.electronApi.handler.ui
          .updateWorkbenchMeta(appInfo.viewId, {
            activeViewIndex: activeViewIndex,
          })
          .catch(console.error);
      },
    );

    const basenameSub = LiveData.computed((get) => ({
      basename: get(workbench.basename$),
      workspaceName: get(this.workspaceService.workspace.name$),
    })).subscribe(({ basename, workspaceName }) => {
      if (!appInfo?.viewId) {
        return;
      }

      this.electronApi.handler.ui
        .updateWorkbenchMeta(appInfo.viewId, {
          basename: basename,
          workspaceName,
        })
        .catch(console.error);
    });

    this.disposables.push(
      () => viewsSub.unsubscribe(),
      () => activeViewIndexSub.unsubscribe(),
      () => basenameSub.unsubscribe(),
    );
  };
}
