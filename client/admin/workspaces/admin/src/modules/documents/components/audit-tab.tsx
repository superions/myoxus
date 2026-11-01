import { AdminDocumentAuditGroupType } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  Button,
  SettingsSection,
  SettingsStatusText,
  SettingsToolbar,
  SimpleGrid,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableScrollContainer,
} from "@myoxus/ui-facade";
import { useState } from "react";

import { useDocumentAuditLogQuery } from "../api";
import { EmptyState, KeyBadge, SelectField, TextField } from "./shared";

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
type AuditEntry = ReturnType<
  typeof useDocumentAuditLogQuery
>["entries"][number];

function translateDynamic(i18n: I18n, key: string, fallback: string) {
  const translated = i18n.t(key as never);
  return translated === key ? fallback : translated;
}

function humanizeEventKey(eventKey: string) {
  return eventKey
    .split(".")
    .filter(Boolean)
    .map((part) =>
      part
        .split("_")
        .filter(Boolean)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" "),
    )
    .join(" · ");
}

function auditEventLabel(i18n: I18n, eventKey: string) {
  return translateDynamic(
    i18n,
    `admin.documents.audit.event-key.${eventKey.replaceAll(".", "__")}`,
    humanizeEventKey(eventKey),
  );
}

function auditTargetLabel(i18n: I18n, target: AuditEntry["target"]) {
  if (!target) return i18n.t("admin.common.none");
  const explicitLabel = target.label?.trim();
  if (explicitLabel) return explicitLabel;

  const typeLabel = translateDynamic(
    i18n,
    `admin.audit-log.filter.targetType.${target.type}`,
    humanizeEventKey(target.type),
  );
  const shortId =
    target.id.length > 12
      ? `${target.id.slice(0, 8)}…${target.id.slice(-4)}`
      : target.id;
  return `${typeLabel} · ${shortId}`;
}

function formatAuditDateTime(i18n: I18n, value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(i18n.language, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
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
  const rangeStart = query.totalCount === 0 ? 0 : offset + 1;
  const rangeEnd = Math.min(offset + query.entries.length, query.totalCount);
  const canPageBack = offset > 0;
  const canPageForward =
    query.entries.length === PAGE_SIZE &&
    offset + query.entries.length < query.totalCount;

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

      {query.entries.length === 0 ? (
        <EmptyState>{i18n.t("admin.documents.audit.empty")}</EmptyState>
      ) : (
        <SettingsSection title={i18n.t("admin.documents.audit.entries.title")}>
          <Stack data-testid="documents-audit-soft-list">
            <TableScrollContainer>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{i18n.t("admin.audit-log.col.time")}</TableHead>
                    <TableHead>
                      {i18n.t("admin.audit-log.col.eventKey")}
                    </TableHead>
                    <TableHead>
                      {i18n.t("admin.documents.audit.group.label")}
                    </TableHead>
                    <TableHead>
                      {i18n.t("admin.audit-log.col.target")}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {query.entries.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell mono>
                        {formatAuditDateTime(i18n, entry.createdAt)}
                      </TableCell>
                      <TableCell>
                        <SettingsStatusText title={entry.eventKey}>
                          {auditEventLabel(i18n, entry.eventKey)}
                        </SettingsStatusText>
                      </TableCell>
                      <TableCell>
                        <KeyBadge
                          value={groupLabels[entry.group] ?? entry.group}
                        />
                      </TableCell>
                      <TableCell>
                        {auditTargetLabel(i18n, entry.target)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableScrollContainer>
            <SettingsToolbar justify="center">
              <Button
                type="button"
                variant="plain"
                disabled={!canPageBack}
                onClick={() =>
                  setOffset((value) => Math.max(0, value - PAGE_SIZE))
                }
              >
                {i18n.t("admin.audit-log.previous")}
              </Button>
              <SettingsStatusText>
                {rangeStart}-{rangeEnd} / {query.totalCount}
              </SettingsStatusText>
              <Button
                type="button"
                variant="plain"
                disabled={!canPageForward}
                onClick={() => setOffset((value) => value + PAGE_SIZE)}
              >
                {i18n.t("admin.audit-log.next")}
              </Button>
            </SettingsToolbar>
          </Stack>
        </SettingsSection>
      )}
    </Stack>
  );
}
