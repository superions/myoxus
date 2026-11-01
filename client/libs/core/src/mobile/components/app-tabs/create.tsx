import { useAsyncCallback } from "@myoxus/core/components/hooks/myoxus-async-hooks";
import { useRegionalPreferences } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import { usePageHelper } from "@myoxus/core/editor/virgultum/page-list/utils";
import { TemplateDocService } from "@myoxus/core/modules/template-doc";
import { useTemplateApplicationAction } from "@myoxus/core/modules/template-doc/view/use-template-application";
import { useI18n } from "@myoxus/i18n";
import { WorkbenchService } from "@myoxus/core/modules/workbench";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { EditIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import track from "@myoxus/track";

import { TabItem } from "./tab-item";
import type { AppTabCustomFCProps } from "./type";

export const AppTabCreate = ({ tab }: AppTabCustomFCProps) => {
  const workbench = useService(WorkbenchService).workbench;
  const workspaceService = useService(WorkspaceService);
  const templateDocService = useService(TemplateDocService);
  const { apply, pending, triggerRef } = useTemplateApplicationAction("mobile");
  const t = useI18n();
  const regionalPreferences = useRegionalPreferences();

  const currentWorkspace = workspaceService.workspace;
  const pageHelper = usePageHelper(currentWorkspace.docCollection);
  const enablePageTemplate = useLiveData(
    templateDocService.setting.enablePageTemplate$,
  );
  const pageTemplateDocId = useLiveData(
    templateDocService.setting.pageTemplateDocId$,
  );

  const createPage = useAsyncCallback(async () => {
    if (enablePageTemplate && pageTemplateDocId) {
      const result = await apply(pageTemplateDocId, {
        creationContext: {},
        date: new Date(),
        regionalPreferences,
      });
      if (!result.ok) return;
      workbench.openDoc({ docId: result.docId, fromTab: "true" });
    } else {
      const doc = pageHelper.createPage(undefined, { show: false });
      workbench.openDoc({ docId: doc.id, fromTab: "true" });
    }
    track.$.navigationPanel.$.createDoc();
  }, [
    enablePageTemplate,
    pageHelper,
    pageTemplateDocId,
    regionalPreferences,
    apply,
    workbench,
  ]);

  return (
    <TabItem
      id={tab.key}
      onClick={createPage}
      activateOnClick={false}
      triggerRef={triggerRef}
      pending={pending}
      label={pending ? t["Loading"]() : t["New Page"]()}
    >
      <EditIcon />
    </TabItem>
  );
};
