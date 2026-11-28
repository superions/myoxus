// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { WorkspaceImportProjectionFragment } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  Accordion,
  AccordionControl,
  AccordionItem,
  AccordionPanel,
  Badge,
  Button,
  Checkbox,
  DialogFooterActions,
  Group,
  MyoxusTitle,
  SettingsNotice,
  SimpleGrid,
  Stack,
  StatCell,
} from "@myoxus/ui-facade";

import {
  getWorkspaceImportDiagnosticText,
  getWorkspaceImportDiagnosticTitle,
  getWorkspaceImportFormatText,
} from "./diagnostics";
import { workspaceImportDiagnosticSourcePath } from "./workspace-import";

type WorkspaceImportPreview = NonNullable<
  WorkspaceImportProjectionFragment["preview"]
>;

const DIAGNOSTIC_SEVERITIES = ["blocking", "informational"] as const;

export function PreviewStep({
  preview,
  requiresConfirmation,
  acceptedChanges,
  busy,
  onAcceptedChangesChange,
  onStartOver,
  onApply,
}: {
  preview: WorkspaceImportPreview;
  requiresConfirmation: boolean;
  acceptedChanges: boolean;
  busy: boolean;
  onAcceptedChangesChange: (checked: boolean) => void;
  onStartOver: () => void;
  onApply: () => void;
}) {
  const t = useI18n();

  return (
    <>
      <Group justify="space-between" align="flex-start">
        <MyoxusTitle order={3} typographySlot="section-title">
          {preview.proposedWorkspaceTitle}
        </MyoxusTitle>
        <Badge>{getWorkspaceImportFormatText(t, preview.detectedFormat)}</Badge>
      </Group>

      <SimpleGrid cols={{ base: 2, sm: 3 }}>
        <StatCell
          density="compact"
          label={t["Documents"]()}
          value={preview.counts.documents}
        />
        <StatCell
          density="compact"
          label={t["com.myoxus.database.index.title"]()}
          value={preview.counts.databases}
        />
        <StatCell
          density="compact"
          label={t["com.myoxus.workspace-import.count.fields"]()}
          value={preview.counts.fields}
        />
        <StatCell
          density="compact"
          label={t["com.myoxus.workspace-import.count.rows"]()}
          value={preview.counts.rows}
        />
        <StatCell
          density="compact"
          label={t["com.myoxus.workspace-import.count.assets"]()}
          value={preview.counts.assets}
        />
        <StatCell
          density="compact"
          label={t["com.myoxus.workspace-import.count.views"]()}
          value={preview.counts.views}
        />
      </SimpleGrid>

      {preview.diagnostics.length > 0 ? (
        <Stack data-myoxus-ui-role="workspace-import-diagnostics">
          {DIAGNOSTIC_SEVERITIES.map((severity) => {
            const entries = preview.diagnostics.filter(
              (item) => item.severity === severity,
            );
            if (entries.length === 0) return null;
            const isBlocking = severity === "blocking";
            return (
              <Stack key={severity}>
                <MyoxusTitle order={4} typographySlot="section-title">
                  {isBlocking
                    ? t["com.myoxus.workspace-import.diagnostics.blocking"]()
                    : t["com.myoxus.workspace-import.diagnostics.changes"]()}
                </MyoxusTitle>
                <Accordion
                  multiple
                  defaultValue={
                    isBlocking ? entries.map((_, idx) => String(idx)) : []
                  }
                >
                  {entries.map((entry, idx) => (
                    <AccordionItem
                      key={`${entry.code}-${idx}`}
                      value={String(idx)}
                    >
                      <AccordionControl>
                        {getWorkspaceImportDiagnosticTitle(t, entry.code)}
                      </AccordionControl>
                      <AccordionPanel>
                        <SettingsNotice
                          tone={isBlocking ? "error" : "info"}
                          title={workspaceImportDiagnosticSourcePath(
                            entry.context,
                          )}
                        >
                          {getWorkspaceImportDiagnosticText(t, entry.code)}
                        </SettingsNotice>
                      </AccordionPanel>
                    </AccordionItem>
                  ))}
                </Accordion>
              </Stack>
            );
          })}
        </Stack>
      ) : null}

      {requiresConfirmation ? (
        <Checkbox
          checked={acceptedChanges}
          data-testid="workspace-import-confirm-changes"
          label={t["com.myoxus.workspace-import.confirm-changes"]()}
          onChange={(_, checked) => onAcceptedChangesChange(checked)}
        />
      ) : null}

      {!preview.applyAllowed ? (
        <SettingsNotice tone="error">
          {t["com.myoxus.workspace-import.preview-blocked"]()}
        </SettingsNotice>
      ) : null}

      <DialogFooterActions>
        <Button
          data-testid="workspace-import-start-over"
          variant="secondary"
          onClick={onStartOver}
        >
          {t["com.myoxus.workspace-import.start-over"]()}
        </Button>
        <Button
          data-testid="workspace-import-apply"
          disabled={
            !preview.applyAllowed ||
            busy ||
            (requiresConfirmation && !acceptedChanges)
          }
          variant="primary"
          onClick={onApply}
        >
          {t["com.myoxus.workspace-import.apply"]()}
        </Button>
      </DialogFooterActions>
    </>
  );
}
