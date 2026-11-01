import { useGuard } from "@myoxus/core/components/guard";
import { useAsyncCallback } from "@myoxus/core/components/hooks/myoxus-async-hooks";
import { DocService, DocsService } from "@myoxus/core/modules/doc";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import { track } from "@myoxus/track";
import {
  DocumentHeaderTitleInlineEdit,
  type InlineEditProps,
} from "@myoxus/ui-facade";
import type { HTMLAttributes } from "react";

export interface VirgultumHeaderTitleProps {
  /** if set, title cannot be edited */
  inputHandleRef?: InlineEditProps["handleRef"];
}

const inputAttrs = {
  "data-testid": "title-content",
} as HTMLAttributes<HTMLInputElement>;
export const VirgultumHeaderTitle = (props: VirgultumHeaderTitleProps) => {
  const { inputHandleRef } = props;
  const workspaceService = useService(WorkspaceService);
  const isSharedMode = workspaceService.workspace.openOptions.isSharedMode;
  const docsService = useService(DocsService);
  const docService = useService(DocService);
  const docTitle = useLiveData(docService.doc.record.title$);
  const t = useI18n();

  const onChange = useAsyncCallback(
    async (v: string) => {
      await docsService.changeDocTitle(docService.doc.id, v);
      track.$.header.actions.renameDoc();
    },
    [docService.doc.id, docsService],
  );

  const canEdit = useGuard("Doc_Update", docService.doc.id);

  return (
    <DocumentHeaderTitleInlineEdit
      value={docTitle}
      onChange={onChange}
      editable={!isSharedMode && canEdit}
      exitible={true}
      placeholder={t["Untitled"]()}
      data-testid="title-edit-button"
      handleRef={inputHandleRef}
      inputAttrs={inputAttrs}
    />
  );
};
