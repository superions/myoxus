import { DocDisplayMetaService } from "@myoxus/core/modules/doc-display-meta";
import { JournalService } from "@myoxus/core/modules/journal";
import { WorkbenchService } from "@myoxus/core/modules/workbench";
import { TodayIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import { useCallback } from "react";

import { TabItem } from "./tab-item";
import type { AppTabCustomFCProps } from "./type";

export const AppTabJournal = ({ tab }: AppTabCustomFCProps) => {
  const workbench = useService(WorkbenchService).workbench;
  const location = useLiveData(workbench.location$);
  const journalService = useService(JournalService);
  const docDisplayMetaService = useService(DocDisplayMetaService);

  const maybeDocId = location.pathname.split("/")[1];
  const journalDate = useLiveData(journalService.journalDate$(maybeDocId));
  const JournalIcon = useLiveData(docDisplayMetaService.icon$(maybeDocId));

  const handleOpenToday = useCallback(() => {
    workbench.open("/journals", { at: "active" });
  }, [workbench]);

  const Icon = journalDate ? JournalIcon : TodayIcon;

  return (
    <TabItem onClick={handleOpenToday} id={tab.key} label="Journal">
      <Icon />
    </TabItem>
  );
};
