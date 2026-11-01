import { DocsService } from "@myoxus/core/modules/doc";
import { DocDisplayMetaService } from "@myoxus/core/modules/doc-display-meta";
import { i18nTime, useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Loading,
  MyoxusText,
  SurfaceList,
  SurfaceListItem,
  SurfaceListItemIcon,
  SurfaceListMeta,
  SurfaceListText,
} from "@myoxus/ui-facade";
import type React from "react";

import type { IgnoredDoc } from "../types";

interface IgnoredDocsProps {
  ignoredDocs: IgnoredDoc[];
  isLoading: boolean;
}

interface DocItemProps {
  doc: IgnoredDoc;
}

const DocItem: React.FC<DocItemProps> = ({ doc }) => {
  const docDisplayService = useService(DocDisplayMetaService);
  const docService = useService(DocsService);
  const docTitle = docDisplayService.title$(doc.docId).value;
  const DocIcon = docDisplayService.icon$(doc.docId).value;
  const docRecord = useLiveData(docService.list.doc$(doc.docId));
  if (!docRecord) {
    return null;
  }
  const updatedDate = docRecord.meta$.value.updatedDate;
  const createdDate = docRecord.meta$.value.createDate;

  const updateDate = updatedDate
    ? i18nTime(updatedDate, {
        relative: true,
      })
    : "-";
  const createDate = createdDate
    ? i18nTime(createdDate, {
        absolute: {
          accuracy: "day",
          noYear: true,
        },
      })
    : "-";

  return (
    <SurfaceListItem
      alignItems="center"
      data-testid="workspace-embedding-setting-ignore-docs-list-item"
      density="compact"
      fullWidth
      layout="row"
    >
      <SurfaceListItemIcon
        size="sm"
        data-myoxus-ui-role="workspace-embedding-ignored-doc-icon"
      >
        <DocIcon />
      </SurfaceListItemIcon>
      <SurfaceListText kind="title" data-testid="ignore-doc-title">
        {docTitle}
      </SurfaceListText>
      <SurfaceListMeta layout="row-cluster">
        <MyoxusText
          component="span"
          tone="secondary"
          typographySlot="body-small"
        >
          {updateDate}
        </MyoxusText>
        <MyoxusText
          component="span"
          tone="secondary"
          typographySlot="body-small"
        >
          {createDate}
        </MyoxusText>
      </SurfaceListMeta>
    </SurfaceListItem>
  );
};

export const IgnoredDocs: React.FC<IgnoredDocsProps> = ({
  ignoredDocs,
  isLoading,
}) => {
  const t = useI18n();

  return (
    <SurfaceList
      data-testid="workspace-embedding-setting-ignore-docs-list"
      label={t[
        "com.myoxus.settings.workspace.indexer-embedding.embedding.ignore-docs.title"
      ]()}
    >
      {isLoading ? (
        <SurfaceListItem
          aria-busy="true"
          data-myoxus-ui-role="workspace-embedding-ignored-docs-loading"
          density="compact"
          muted
        >
          <Loading />
        </SurfaceListItem>
      ) : (
        ignoredDocs.map((doc) => <DocItem key={doc.docId} doc={doc} />)
      )}
    </SurfaceList>
  );
};
