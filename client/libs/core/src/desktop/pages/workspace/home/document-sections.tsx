// SPDX-License-Identifier: AGPL-3.0-or-later

import { useRegionalFormatters } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import type { DocRecord } from "@myoxus/core/modules/doc";
import { DocDisplayMetaService } from "@myoxus/core/modules/doc-display-meta";
import { WorkbenchService } from "@myoxus/core/modules/workbench";
import { i18nTime, useI18n } from "@myoxus/i18n";
import { NewPageIcon, RecentIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Button,
  Center,
  Loading,
  MyoxusText,
  NavigationLink,
  Notice,
  Stack,
} from "@myoxus/ui-facade";
import { useCallback } from "react";

import type { DashboardDocument } from "./document-views";
import { DashboardSection } from "./section";

const DashboardDocumentRow = ({
  document,
  timestamp,
}: {
  document: DashboardDocument;
  timestamp: "createDate" | "updatedDate";
}) => {
  const t = useI18n();
  const workbench = useService(WorkbenchService).workbench;
  const displayMeta = useService(DocDisplayMetaService);
  const Icon = useLiveData(displayMeta.icon$(document.id));
  const { formatDateTime } = useRegionalFormatters();
  const value = document[timestamp]!;
  const openDocument = useCallback(
    () => workbench.openDoc(document.id),
    [document.id, workbench],
  );

  return (
    <NavigationLink
      component="button"
      type="button"
      label={document.title || t["Untitled"]()}
      description={
        <MyoxusText
          component="time"
          dateTime={new Date(value).toISOString()}
          title={formatDateTime(value)}
          tone="secondary"
          typographySlot="body-small"
        >
          {i18nTime(value, { relative: true })}
        </MyoxusText>
      }
      leftSection={<Icon />}
      onClick={openDocument}
      data-myoxus-ui-role="workspace-home-document-row"
      data-doc-id={document.id}
    />
  );
};

export const DashboardDocumentSection = ({
  documents,
  error,
  kind,
  loading,
  onOpenAll,
  onRetry,
  workspaceName,
}: {
  documents: readonly DashboardDocument[];
  error: boolean;
  kind: "new" | "recent";
  loading: boolean;
  onOpenAll: () => void;
  onRetry: () => void;
  workspaceName: string;
}) => {
  const t = useI18n();
  const isNew = kind === "new";
  const title = isNew
    ? t["com.myoxus.workspace-home.new-documents"]()
    : t["com.myoxus.diagrams.catalog.recent"]();

  return (
    <DashboardSection
      busy={loading}
      action={{
        label: t["All content"](),
        onClick: onOpenAll,
      }}
      icon={isNew ? <NewPageIcon aria-hidden /> : <RecentIcon aria-hidden />}
      scope={workspaceName}
      title={title}
      uiRole={`workspace-home-${kind}-documents`}
    >
      {error ? (
        <Notice
          title={t["com.myoxus.error.unexpected-error.title"]()}
          tone="error"
        >
          <Button variant="secondary" onClick={onRetry}>
            {t["Retry"]()}
          </Button>
        </Notice>
      ) : loading ? (
        <Loading />
      ) : documents.length ? (
        <Stack gap={0}>
          {documents.map((document) => (
            <DashboardDocumentRow
              document={document}
              key={document.id}
              timestamp={isNew ? "createDate" : "updatedDate"}
            />
          ))}
        </Stack>
      ) : (
        <Center>
          <Stack align="center" gap="xs">
            <MyoxusText typographySlot="nav">
              {isNew
                ? t["com.myoxus.workspace-home.no-documents"]()
                : t["com.myoxus.workspace-home.no-recent-documents"]()}
            </MyoxusText>
            <MyoxusText
              textAlign="center"
              tone="secondary"
              typographySlot="body-small"
            >
              {isNew
                ? t["com.myoxus.empty.docs.all-description"]()
                : t["com.myoxus.diagrams.catalog.recent-empty"]()}
            </MyoxusText>
          </Stack>
        </Center>
      )}
    </DashboardSection>
  );
};

export function createDashboardDocumentSnapshots(
  records: ReadonlyMap<string, DocRecord>,
): DashboardDocument[] {
  return [...records.values()].map((record) => {
    const meta = record.meta$.value;
    return {
      createDate: meta.createDate,
      id: record.id,
      journalDate: record.journalDate$.value ?? undefined,
      mode: record.primaryMode$.value,
      title: meta.title ?? "",
      trash: meta.trash ?? false,
      updatedDate: meta.updatedDate,
    };
  });
}
