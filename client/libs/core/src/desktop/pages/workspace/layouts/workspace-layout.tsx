import { AiLoginRequiredModal } from "@myoxus/core/components/myoxus/auth/ai-login-required";
import { SWRConfigProvider } from "@myoxus/core/components/providers/swr-config-provider";
import { WorkspaceRuntime } from "@myoxus/core/components/providers/workspace-runtime";
import { WorkspaceContentOperationResume } from "@myoxus/core/components/workspace-content-operation/resume";
import { AIIsland } from "@myoxus/core/desktop/components/ai-island";
import { AppContainer } from "@myoxus/core/desktop/components/app-container";
import { DocumentTitle } from "@myoxus/core/desktop/components/document-title";
import { WorkspaceDialogs } from "@myoxus/core/desktop/dialogs/workspace";
import { PeekViewManagerModal } from "@myoxus/core/modules/peek-view";
import { QuotaCheck, QuotaUploadWatcher } from "@myoxus/core/modules/quota";
import { WorkbenchService } from "@myoxus/core/modules/workbench";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { LiveData, useLiveData, useService } from "@myoxus/infra";
import { uniReactRoot } from "@myoxus/lit-react";
import type { PropsWithChildren } from "react";

/**
 * Root layout component wrapping all workspace-scoped content.
 *
 * Renders the full provider + side-effect layer on top of the workbench
 * content area. Should be used as the direct parent of `<WorkbenchRoot>`.
 *
 * @param children - The workbench content; typically `<WorkbenchRoot />`.
 */
export const WorkspaceLayout = function WorkspaceLayout({
  children,
}: PropsWithChildren) {
  const currentWorkspace = useService(WorkspaceService).workspace;
  return (
    <SWRConfigProvider>
      <WorkspaceContentOperationResume />
      <WorkspaceDialogs />

      {/* ---- some side-effect components ---- */}
      {currentWorkspace?.flavour !== "local" ? (
        <>
          <QuotaCheck workspaceMeta={currentWorkspace.meta} />
          <QuotaUploadWatcher />
        </>
      ) : null}
      <AiLoginRequiredModal />
      <WorkspaceRuntime />
      <PeekViewManagerModal />
      <DocumentTitle />

      <WorkspaceLayoutInner>{children}</WorkspaceLayoutInner>
      <AIIsland />
      <uniReactRoot.Root />
    </SWRConfigProvider>
  );
};

/**
 * Inner UI container that tracks the current workbench path.
 *
 * Attaches `data-current-path` to the `<AppContainer>` root so that CSS
 * selectors and end-to-end tests can inspect the active route without parsing
 * the URL. Responsive sidebar behavior is owned by the shared UI facade, not by
 * this workspace layout.
 */
const WorkspaceLayoutUIContainer = ({ children }: PropsWithChildren) => {
  const workbench = useService(WorkbenchService).workbench;
  const currentPath = useLiveData(
    LiveData.computed((get) => {
      return get(workbench.basename$) + get(workbench.location$).pathname;
    }),
  );

  return (
    <AppContainer data-current-path={currentPath}>{children}</AppContainer>
  );
};
/**
 * Thin adapter between `WorkspaceLayout` and `WorkspaceLayoutUIContainer`.
 *
 * Exists as a separate component so that additional providers or layout
 * concerns can be inserted here in the future without touching the outer
 * layout's public API.
 */
const WorkspaceLayoutInner = ({ children }: PropsWithChildren) => {
  return <WorkspaceLayoutUIContainer>{children}</WorkspaceLayoutUIContainer>;
};
