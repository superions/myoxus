// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { AdminDocumentAuditGroupType } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  SettingsSection,
  SettingsStatusText,
  SimpleGrid,
  Stack,
  TableCell,
  TableRow,
} from "@myoxus/ui-facade";
import { useState } from "react";

import { formatAdminDateTime } from "../../../utils/locale-format";
import {
  auditTargetLabel,
  humanizeEventKey,
} from "../../audit-log/audit-labels";
import { AuditPaginatedTable } from "../../audit-log/components/audit-table-section";
import { useDocumentAuditLogQuery } from "../api";
import { KeyBadge, SelectField, TextField } from "./shared";

const GROUPS = [
  "",
  AdminDocumentAuditGroupType.document_lifecycle,
  AdminDocumentAuditGroupType.metadata_policy,
  AdminDocumentAuditGroupType.status_schema,
  AdminDocumentAuditGroupType.status_transition,
  AdminDocumentAuditGroupType.document_type,
  AdminDocumentAuditGroupType.version_policy,
  AdminDocumentAuditGroupType.workspace_settings,
  AdminDocumentAuditGroupType.document_metadata,
  AdminDocumentAuditGroupType.document_version,
  AdminDocumentAuditGroupType.pdf_export,
] as const;

const PAGE_SIZE = 50;

type GroupFilter = (typeof GROUPS)[number];
type I18n = ReturnType<typeof useI18n>;

function auditEventLabel(i18n: I18n, eventKey: string) {
  const key = `admin.documents.audit.event-key.${eventKey.replaceAll(".", "__")}`;
  const translated = i18n.t(key as never);
  return translated === key ? humanizeEventKey(eventKey) : translated;
}

export function AuditTab() {
  const i18n = useI18n();
  const [group, setGroup] = useState<GroupFilter>("");
  const [eventKeyPrefix, setEventKeyPrefix] = useState("");
  const [offset, setOffset] = useState(0);
  const query = useDocumentAuditLogQuery(
    {
      ...(group ? { groups: [group] } : {}),
      ...(eventKeyPrefix.trim()
        ? { eventKeyPrefix: eventKeyPrefix.trim() }
        : {}),
    },
    { limit: PAGE_SIZE, offset },
  );
  const groupLabels = Object.fromEntries(
    GROUPS.map((value) => [
      value,
      value
        ? i18n.t(`admin.documents.audit.group.${value}` as never)
        : i18n.t("admin.documents.audit.group.all"),
    ]),
  );

  return (
    <Stack>
      <SettingsSection
        title={i18n.t("admin.documents.audit.filter.title")}
        description={i18n.t("admin.documents.audit.filter.description")}
      >
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <SelectField
            id="audit-group"
            label={i18n.t("admin.documents.audit.group.label")}
            value={group}
            values={[...GROUPS]}
            optionLabels={groupLabels}
            onChange={(value) => {
              setGroup(value as GroupFilter);
              setOffset(0);
            }}
          />
          <TextField
            id="audit-event-prefix"
            label={i18n.t("admin.documents.field.event-prefix")}
            value={eventKeyPrefix}
            onChange={(value) => {
              setEventKeyPrefix(value);
              setOffset(0);
            }}
          />
        </SimpleGrid>
      </SettingsSection>

      <SettingsSection title={i18n.t("admin.documents.audit.entries.title")}>
        <AuditPaginatedTable
          data-testid="documents-audit-soft-list"
          columns={[
            { key: "time", label: i18n.t("admin.audit-log.col.time") },
            { key: "eventKey", label: i18n.t("admin.audit-log.col.eventKey") },
            {
              key: "group",
              label: i18n.t("admin.documents.audit.group.label"),
            },
            { key: "target", label: i18n.t("admin.audit-log.col.target") },
          ]}
          entryCount={query.entries.length}
          totalCount={query.totalCount}
          offset={offset}
          pageSize={PAGE_SIZE}
          onOffsetChange={setOffset}
          emptyTitle={i18n.t("admin.documents.audit.empty")}
        >
          {query.entries.map((entry) => (
            <TableRow key={entry.id}>
              <TableCell mono>
                {formatAdminDateTime(i18n.language, entry.createdAt)}
              </TableCell>
              <TableCell>
                <SettingsStatusText title={entry.eventKey}>
                  {auditEventLabel(i18n, entry.eventKey)}
                </SettingsStatusText>
              </TableCell>
              <TableCell>
                <KeyBadge value={groupLabels[entry.group] ?? entry.group} />
              </TableCell>
              <TableCell>
                {auditTargetLabel(
                  entry.target,
                  i18n.t,
                  i18n.t("admin.common.none"),
                )}
              </TableCell>
            </TableRow>
          ))}
        </AuditPaginatedTable>
      </SettingsSection>
    </Stack>
  );
}
