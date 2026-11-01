// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ViewService } from "@myoxus/core/modules/workbench/services/view";
import { WorkbenchService } from "@myoxus/core/modules/workbench/services/workbench";
import { useEnableAI } from "@myoxus/core/components/hooks/myoxus/use-enable-ai";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import {
  HeaderMenuButton,
  MenuItem,
  MenuSeparator,
  MenuSub,
} from "@myoxus/ui-facade";

function useWorkbenchToolsMenuModel() {
  const view = useService(ViewService).view;
  const registeredSurfaces = useLiveData(view.contextSurfaces$);
  const toolLayout = useLiveData(view.toolLayout$);
  const enableAI = useEnableAI();
  const contextSurfaces = registeredSurfaces.filter(
    (surface) => surface.id !== "chat" || enableAI,
  );
  const workbench = useService(WorkbenchService).workbench;

  return { contextSurfaces, toolLayout, view, enableAI, workbench };
}

function WorkbenchToolsMenuSubContent({
  contextSurfaces,
  toolLayout,
  view,
  enableAI,
  workbench,
}: ReturnType<typeof useWorkbenchToolsMenuModel>) {
  const t = useI18n();

  return (
    <MenuSub
      items={
        <>
          {contextSurfaces.map((surface) => {
            const visible = toolLayout.visibleToolIds.includes(surface.id);
            return (
              <MenuItem
                key={surface.id}
                checked={surface.id === "chat" ? undefined : visible}
                closeMenuOnClick={surface.id === "chat"}
                data-testid={`workbench-tool-menu-${surface.id}`}
                onSelect={() => {
                  // Chat is a destination command: reopening must not remove a
                  // retained conversation. Other tools keep membership toggles.
                  if (surface.id === "chat") {
                    view.showTool(surface.id);
                  } else if (visible) {
                    view.hideTool(surface.id);
                  } else {
                    view.showTool(surface.id);
                  }
                }}
              >
                {surface.label}
              </MenuItem>
            );
          })}
          {enableAI ? (
            <>
              {contextSurfaces.length ? <MenuSeparator /> : null}
              <MenuItem
                data-testid="workbench-open-workspace-chat"
                onSelect={() => {
                  workbench.open("/chat");
                  workbench.closeContextPanel();
                }}
              >
                {t["com.myoxus.ai.chat-panel.open-workspace-chat"]()}
              </MenuItem>
            </>
          ) : null}
        </>
      }
    >
      {t["com.myoxus.workbench.contextPanel.title"]()}
    </MenuSub>
  );
}

/** Shared tool membership and gated chat destinations for Workbench headers. */
export function WorkbenchToolsMenuSub() {
  const model = useWorkbenchToolsMenuModel();
  if (model.contextSurfaces.length === 0 && !model.enableAI) return null;
  return <WorkbenchToolsMenuSubContent {...model} />;
}

/** Header trigger also remains available for chat on routes without doc tools. */
export function WorkbenchToolsHeaderMenuButton() {
  const t = useI18n();
  const model = useWorkbenchToolsMenuModel();
  if (model.contextSurfaces.length === 0 && !model.enableAI) return null;

  return (
    <HeaderMenuButton
      ariaLabel={t["com.myoxus.common.open-menu"]()}
      data-testid="header-dropDownButton"
      data-myoxus-ui-owner="workbench-tools-menu"
      items={<WorkbenchToolsMenuSubContent {...model} />}
    />
  );
}
