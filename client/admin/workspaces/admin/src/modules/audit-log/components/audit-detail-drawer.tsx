// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * AuditDetailDrawer — immutable audit inspection surface.
 *
 * The drawer renders a side-by-side JSON diff instead of a single raw payload so
 * reviewers can see exactly which audited fields changed. Clipboard export keeps
 * the redacted visual contract by copying the same public audit envelope, not a
 * hidden raw server object.
 */
import type { AdminAuditLogEntryType } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { Check, Copy } from "@myoxus/icons/react";
import {
  IconButton,
  Drawer,
  SettingsDefinitionItem,
  SettingsDefinitionList,
  SettingsListItemMeta,
  SettingsSectionHeading,
  SettingsToolbar,
  Stack,
  Textarea,
} from "@myoxus/ui-facade";
import { useState } from "react";

import { formatAdminDateTime } from "../../../utils/locale-format";
import { auditActorLabel, eventLabel } from "../audit-labels";
import { AuditJsonDiff, redactAuditValue } from "./audit-json-diff";

interface AuditDetailDrawerProps {
  entry: AdminAuditLogEntryType | null;
  onClose: () => void;
}

export function AuditDetailDrawer({ entry, onClose }: AuditDetailDrawerProps) {
  const i18n = useI18n();
  const [copied, setCopied] = useState(false);

  const publicEnvelope = entry
    ? {
        id: entry.id,
        eventKey: entry.eventKey,
        category: entry.category,
        createdAt: entry.createdAt,
        actor: entry.actor,
        target: entry.target,
        oldValue: redactAuditValue(entry.oldValue),
        newValue: redactAuditValue(entry.newValue),
        metadata: redactAuditValue(entry.metadata),
      }
    : null;
  const json = publicEnvelope ? JSON.stringify(publicEnvelope, null, 2) : "";

  function handleCopy() {
    if (!navigator.clipboard) return;
    void navigator.clipboard.writeText(json).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <Drawer
      open={entry !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={i18n.t("admin.audit-log.detail.title")}
      closeButtonLabel={i18n.t("admin.common.close")}
      size="xl"
      aria-label={i18n.t("admin.audit-log.detail.title")}
    >
      <Stack>
        {entry ? (
          <>
            <SettingsToolbar justify="space-between" align="flex-start">
              <Stack>
                <SettingsListItemMeta>{entry.category}</SettingsListItemMeta>
                <SettingsSectionHeading level={2}>
                  {eventLabel(entry.eventKey, i18n.t)}
                </SettingsSectionHeading>
              </Stack>
              <IconButton
                tooltip={
                  copied
                    ? i18n.t("admin.audit-log.detail.copied")
                    : i18n.t("admin.audit-log.detail.copy")
                }
                onClick={handleCopy}
              >
                {copied ? (
                  <Check aria-hidden="true" />
                ) : (
                  <Copy aria-hidden="true" />
                )}
              </IconButton>
            </SettingsToolbar>

            <Stack>
              <SettingsDefinitionList>
                <SettingsDefinitionItem
                  label={i18n.t("admin.audit-log.detail.event-key")}
                >
                  {entry.eventKey}
                </SettingsDefinitionItem>
                <SettingsDefinitionItem
                  label={i18n.t("admin.audit-log.detail.created-at")}
                >
                  {formatAdminDateTime(i18n.language, entry.createdAt)}
                </SettingsDefinitionItem>
                <SettingsDefinitionItem
                  label={i18n.t("admin.audit-log.detail.actor")}
                >
                  {auditActorLabel(entry.actor, i18n.t)}
                </SettingsDefinitionItem>
                <SettingsDefinitionItem
                  label={i18n.t("admin.audit-log.detail.target")}
                >
                  {entry.target?.label ?? entry.target?.id ?? "-"}
                </SettingsDefinitionItem>
              </SettingsDefinitionList>

              <AuditJsonDiff
                oldValue={entry.oldValue}
                newValue={entry.newValue}
              />

              <Textarea
                label={i18n.t("admin.audit-log.detail.metadata")}
                mono
                readOnly
                autosize
                minRows={3}
                value={JSON.stringify(
                  redactAuditValue(entry.metadata),
                  null,
                  2,
                )}
                aria-label={i18n.t("admin.audit-log.detail.metadata")}
              />
            </Stack>
          </>
        ) : null}
      </Stack>
    </Drawer>
  );
}
