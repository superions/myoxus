import { useAsyncCallback } from "@myoxus/core/components/hooks/myoxus-async-hooks";
import { useRegionalPreferences } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import { usePageHelper } from "@myoxus/core/editor/virgultum/page-list/utils";
import { EditorSettingService } from "@myoxus/core/modules/editor-setting";
import {
  type TemplateCategoryFilter,
  TemplateDocService,
  TemplateSuggestionSurface,
} from "@myoxus/core/modules/template-doc";
import {
  TemplateListMenuAdd,
  TemplateListMenuContentScrollable,
} from "@myoxus/core/modules/template-doc/view/template-list-menu";
import { useTemplateApplicationAction } from "@myoxus/core/modules/template-doc/view/use-template-application";
import { WorkbenchService } from "@myoxus/core/modules/workbench";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { inferOpenMode } from "@myoxus/core/utils";
import { useI18n } from "@myoxus/i18n";
import {
  ChevronDownIcon,
  EdgelessIcon,
  PageIcon,
  PlusIcon,
  TemplateIcon,
} from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import track from "@myoxus/track";
import {
  Menu,
  MenuItem,
  MenuSeparator,
  MenuSub,
  SidebarNavItem,
} from "@myoxus/ui-facade";
import type { DocMode } from "@virgultum/editor/model";
import type React from "react";
import { type MouseEvent, useCallback } from "react";

/**
 * @return a function to create a new doc, will duplicate the template doc if the page template is enabled
 */
const useNewDoc = () => {
  const workspaceService = useService(WorkspaceService);
  const templateDocService = useService(TemplateDocService);
  const application = useTemplateApplicationAction("sidebar");
  const workbench = useService(WorkbenchService).workbench;
  const regionalPreferences = useRegionalPreferences();

  const currentWorkspace = workspaceService.workspace;
  const enablePageTemplate = useLiveData(
    templateDocService.setting.enablePageTemplate$,
  );
  const pageTemplateDocId = useLiveData(
    templateDocService.setting.pageTemplateDocId$,
  );

  const pageHelper = usePageHelper(currentWorkspace.docCollection);

  const createPage = useCallback(
    async (e?: MouseEvent, mode?: DocMode) => {
      if (enablePageTemplate && pageTemplateDocId) {
        const result = await application.apply(pageTemplateDocId, {
          creationContext: {},
          date: new Date(),
          regionalPreferences,
        });
        if (!result.ok) return false;
        workbench.openDoc(result.docId, { at: inferOpenMode(e) });
      } else {
        pageHelper.createPage(mode, { at: inferOpenMode(e) });
      }
      return true;
    },
    [
      enablePageTemplate,
      pageHelper,
      pageTemplateDocId,
      regionalPreferences,
      application.apply,
      workbench,
    ],
  );

  return { createPage, ...application };
};

interface AddPageButtonProps {
  className?: string;
  style?: React.CSSProperties;
}

const genericPickerFilter: TemplateCategoryFilter = { exclude: ["onboarding"] };
export function AddPageButton(props: AddPageButtonProps) {
  const editorSetting = useService(EditorSettingService);
  const newDocDefaultMode = useLiveData(
    editorSetting.editorSetting.settings$.selector((s) => s.newDocDefaultMode),
  );

  return newDocDefaultMode === "ask" ? (
    <AddPageWithAsk {...props} />
  ) : (
    <AddPageWithoutAsk {...props} />
  );
}

type NewDocMenuItemsProps = {
  disabled: boolean;
  createDocFromTemplate: (templateId: string) => void;
  createEdgeless: (e?: MouseEvent) => void;
  createPage: (e?: MouseEvent) => void;
};

function NewDocMenuItems({
  disabled,
  createDocFromTemplate,
  createEdgeless,
  createPage,
}: NewDocMenuItemsProps) {
  const t = useI18n();

  return (
    <>
      <MenuItem
        disabled={disabled}
        prefixIcon={<PageIcon />}
        onClick={createPage}
        onAuxClick={createPage}
      >
        {t["Page"]()}
      </MenuItem>
      <MenuItem
        disabled={disabled}
        prefixIcon={<EdgelessIcon />}
        onClick={createEdgeless}
        onAuxClick={createEdgeless}
      >
        {t["Edgeless"]()}
      </MenuItem>
      <MenuSub
        triggerOptions={{
          prefixIcon: <TemplateIcon />,
        }}
        subContentOptions={{
          panelWidth: "display",
        }}
        items={
          <TemplateListMenuContentScrollable
            disabled={disabled}
            onSelect={createDocFromTemplate}
            categoryFilter={genericPickerFilter}
            suggestionSurface={TemplateSuggestionSurface.SidebarNewPage}
            suffixItems={
              <>
                <MenuSeparator />
                <TemplateListMenuAdd />
              </>
            }
          />
        }
      >
        {t["Template"]()}
      </MenuSub>
    </>
  );
}

function AddPageWithAsk({ className, style }: AddPageButtonProps) {
  const t = useI18n();
  const { createPage: createDoc, apply, pending, triggerRef } = useNewDoc();
  const workbench = useService(WorkbenchService).workbench;
  const regionalPreferences = useRegionalPreferences();

  const createPage = useAsyncCallback(
    async (e?: MouseEvent) => {
      if (!(await createDoc(e, "page"))) return;
      track.$.navigationPanel.$.createDoc();
      track.$.sidebar.newDoc.quickStart({ with: "page" });
    },
    [createDoc],
  );
  const createEdgeless = useAsyncCallback(
    async (e?: MouseEvent) => {
      if (!(await createDoc(e, "edgeless"))) return;
      track.$.navigationPanel.$.createDoc();
      track.$.sidebar.newDoc.quickStart({ with: "edgeless" });
    },
    [createDoc],
  );

  const createDocFromTemplate = useAsyncCallback(
    async (templateId: string) => {
      const result = await apply(templateId, {
        creationContext: {},
        date: new Date(),
        regionalPreferences,
      });
      if (!result.ok) return;
      workbench.openDoc(result.docId);
      track.$.sidebar.newDoc.quickStart({ with: "template" });
    },
    [regionalPreferences, apply, workbench],
  );

  return (
    <Menu
      contentOptions={{
        side: "right",
        align: "start",
        panelWidth: "display",
      }}
      items={
        <NewDocMenuItems
          disabled={pending}
          createDocFromTemplate={createDocFromTemplate}
          createEdgeless={createEdgeless}
          createPage={createPage}
        />
      }
    >
      <SidebarNavItem
        ref={triggerRef}
        disabled={pending}
        aria-busy={pending}
        aria-label={pending ? t["Loading"]() : undefined}
        actions={<ChevronDownIcon aria-hidden />}
        className={className}
        data-myoxus-ui-role="button:sidebar-new-page-menu"
        data-testid="sidebar-new-page-with-ask-button"
        icon={<PlusIcon />}
        style={style}
      >
        {t["New Page"]()}
      </SidebarNavItem>
    </Menu>
  );
}

function AddPageWithoutAsk({ className, style }: AddPageButtonProps) {
  const { createPage: createDoc, pending, triggerRef } = useNewDoc();

  const onClickNewPage = useAsyncCallback(
    async (e?: MouseEvent) => {
      if (!(await createDoc(e))) return;
      track.$.navigationPanel.$.createDoc();
    },
    [createDoc],
  );
  const t = useI18n();

  return (
    <SidebarNavItem
      ref={triggerRef}
      disabled={pending}
      aria-busy={pending}
      aria-label={pending ? t["Loading"]() : undefined}
      className={className}
      data-myoxus-ui-role="button:sidebar-new-page"
      data-testid="sidebar-new-page-button"
      icon={<PlusIcon />}
      onAuxClick={onClickNewPage}
      onClick={onClickNewPage}
      style={style}
    >
      {t["New Page"]()}
    </SidebarNavItem>
  );
}
