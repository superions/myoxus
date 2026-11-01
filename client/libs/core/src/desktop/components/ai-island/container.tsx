import { DocsService } from "@myoxus/core/modules/doc";
import { GlobalContextService } from "@myoxus/core/modules/global-context";
import { useLiveData, useService } from "@myoxus/infra";
import { FloatingActionDock } from "@myoxus/ui-facade";
import type { PropsWithChildren, ReactElement } from "react";

export const IslandContainer = (
  props: PropsWithChildren<{ concealed?: boolean }>,
): ReactElement => {
  const docId = useLiveData(
    useService(GlobalContextService).globalContext.docId.$,
  );
  const docRecordList = useService(DocsService).list;
  const doc = useLiveData(docId ? docRecordList.doc$(docId) : undefined);
  const inTrash = useLiveData(doc?.meta$)?.trash;
  return (
    <FloatingActionDock
      concealed={props.concealed}
      elevated={Boolean(inTrash)}
      data-myoxus-ui-role="ai-island-dock"
    >
      {props.children}
    </FloatingActionDock>
  );
};
