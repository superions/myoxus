// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useGuard } from "@myoxus/core/components/guard/use-guard";
import { useSystemOnline } from "@myoxus/core/components/hooks/use-system-online";
import { bpmnSourceErrorText } from "@myoxus/core/modules/bpmn-editor/source-message";
import type { MermaidDiagramsService } from "@myoxus/core/modules/mermaid-diagrams";
import {
  type BpmnImportResult,
  isPreservableBpmnImport,
} from "@myoxus/core/modules/mermaid-diagrams/services/bpmn-import";
import { WorkspaceServerService } from "@myoxus/core/modules/server";
import { WorkbenchService } from "@myoxus/core/modules/workbench/services/workbench";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { useI18n } from "@myoxus/i18n";
import { InformationIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Accordion,
  AccordionControl,
  AccordionItem,
  AccordionPanel,
  Badge,
  Button,
  DialogFooterActions,
  Dropzone,
  Group,
  MenuItem,
  MenuPanel,
  MyoxusText,
  MyoxusTitle,
  Notice,
  notify,
  Stack,
  Text,
  Tooltip,
} from "@myoxus/ui-facade";
import { downloadBlob } from "@virgultum/editor/shared/utils";
import type { ReactElement, SVGAttributes } from "react";

import {
  IMPORT_FORMAT_OPTIONS,
  type ImportResult,
  type ImportType,
  inferDroppedImportType,
} from "./handlers";

function ImportOptionItem({
  label,
  prefixIcon,
  type,
  onImport,
  unavailableReason,
  ...props
}: {
  label: string;
  prefixIcon: ReactElement<SVGAttributes<SVGElement>>;
  type: ImportType;
  onImport: (type: ImportType) => void | Promise<unknown>;
  unavailableReason?: string;
  "data-testid"?: string;
}) {
  const t = useI18n();
  const translatedLabel =
    typeof (t as unknown as Record<string, () => string>)[label] === "function"
      ? (t as unknown as Record<string, () => string>)[label]()
      : label;

  return (
    <Tooltip
      content={unavailableReason}
      events={{ hover: true, focus: true, touch: false }}
    >
      <MenuItem
        block
        aria-disabled={Boolean(unavailableReason)}
        aria-description={unavailableReason}
        suffixIcon={unavailableReason ? <InformationIcon /> : undefined}
        closeMenuOnClick={!unavailableReason}
        onSelect={() => {
          if (!unavailableReason) void onImport(type);
        }}
        prefixIcon={prefixIcon}
        {...props}
      >
        {translatedLabel}
      </MenuItem>
    </Tooltip>
  );
}

export const ImportMenuItems = ({
  onImport,
}: {
  onImport: (type: ImportType) => void | Promise<unknown>;
}) => {
  const t = useI18n();
  const workspace = useService(WorkspaceService).workspace;
  const server = useLiveData(useService(WorkspaceServerService).server$);
  const online = useSystemOnline();
  const canCreate = useGuard("Workspace_CreateDoc");

  const wordUnavailable =
    workspace.flavour === "local" || !server || !online
      ? t["com.myoxus.import.word.unavailable"]()
      : canCreate === false
        ? t["com.myoxus.import.word.permission"]()
        : canCreate === undefined
          ? t.Loading()
          : undefined;

  return (
    <>
      {IMPORT_FORMAT_OPTIONS.map(({ key, label, prefixIcon, testId, type }) => (
        <ImportOptionItem
          key={key}
          prefixIcon={prefixIcon}
          label={label}
          type={type}
          unavailableReason={type === "docx" ? wordUnavailable : undefined}
          onImport={onImport}
          data-testid={testId}
        />
      ))}
    </>
  );
};

export function ImportOptionsView({
  onImport,
}: {
  onImport: (
    type: ImportType,
    droppedFiles?: File[],
  ) => void | Promise<unknown>;
}) {
  const t = useI18n();

  return (
    <>
      <MyoxusTitle order={2} textAlign="center" typographySlot="section-title">
        {t["Import"]()}
      </MyoxusTitle>
      <Dropzone
        activateOnClick={false}
        activateOnKeyboard={false}
        enablePointerEvents
        onDrop={(files) => {
          const detected = inferDroppedImportType(files);
          if (detected) {
            void onImport(detected, files);
            return;
          }
          notify.error({
            title: t["com.myoxus.import.status.failed.title"](),
            message: files[0]?.name,
          });
        }}
        data-myoxus-ui-role="import-dialog-dropzone"
      >
        <MenuPanel panelWidth="wide">
          <ImportMenuItems onImport={onImport} />
        </MenuPanel>
      </Dropzone>
    </>
  );
}

export function ImportingStatusView() {
  const t = useI18n();
  return (
    <>
      <MyoxusTitle order={2} textAlign="center" typographySlot="section-title">
        {t["com.myoxus.import.status.importing.title"]()}
      </MyoxusTitle>
      <MyoxusText component="p" textAlign="center" tone="secondary">
        {t["com.myoxus.import.status.importing.message"]()}
      </MyoxusText>
    </>
  );
}

export const SuccessStatus = ({
  onComplete,
  result,
}: {
  onComplete: () => void;
  result: ImportResult | null;
}) => {
  const t = useI18n();
  const diag = result?.markdownDiagnostics;

  return (
    <>
      <MyoxusTitle order={2} textAlign="center" typographySlot="section-title">
        {t["com.myoxus.import.status.success.title"]()}
      </MyoxusTitle>
      <MyoxusText component="p" textAlign="center" tone="secondary">
        {t["com.myoxus.import.status.success.message"]()}
      </MyoxusText>
      {diag && (diag.unresolvedReferences || diag.unsupportedReferences) ? (
        <MyoxusText component="p" textAlign="center" tone="warning">
          {t["com.myoxus.import.markdown.reference-diagnostics.message"]({
            unresolved: String(diag.unresolvedReferences),
            unsupported: String(diag.unsupportedReferences),
          })}
        </MyoxusText>
      ) : null}
      {diag && (diag.unsupportedAnnotations || diag.normalizedAnnotations) ? (
        <MyoxusText component="p" textAlign="center" tone="warning">
          {t["com.myoxus.markdown.annotation-diagnostics.message"]({
            unsupported: String(diag.unsupportedAnnotations ?? 0),
            normalized: String(diag.normalizedAnnotations ?? 0),
          })}
        </MyoxusText>
      ) : null}
      {diag?.unsupportedCallouts ? (
        <MyoxusText component="p" textAlign="center" tone="warning">
          {t["com.myoxus.markdown.callout-diagnostics"]({
            count: String(diag.unsupportedCallouts),
          })}
        </MyoxusText>
      ) : null}
      {diag?.unsupportedMath ? (
        <MyoxusText component="p" textAlign="center" tone="warning">
          {t["com.myoxus.markdown.math-diagnostics"]({
            count: String(diag.unsupportedMath),
          })}
        </MyoxusText>
      ) : null}
      {diag?.unsupportedTables ? (
        <MyoxusText component="p" textAlign="center" tone="warning">
          {t["com.myoxus.markdown.table-diagnostics"]({
            count: String(diag.unsupportedTables),
          })}
        </MyoxusText>
      ) : null}
      <DialogFooterActions>
        <Button onClick={onComplete} variant="primary">
          {t["Complete"]()}
        </Button>
      </DialogFooterActions>
    </>
  );
};

/**
 * Displays per-file BPMN outcomes together so partial batches never collapse
 * into generic success; retry skips ready entries and preserves original IDs.
 */
export function BpmnImportStatusView({
  result,
  registry,
  onRetry,
  onComplete,
}: {
  result: BpmnImportResult;
  registry: MermaidDiagramsService;
  onRetry: () => Promise<void>;
  onComplete: () => void;
}) {
  const t = useI18n();
  const creation = useLiveData(registry.creation$);
  const workbench = useService(WorkbenchService).workbench;
  const unfinished = result.entries.some(
    (entry) =>
      isPreservableBpmnImport(entry) && entry.creation?.status !== "ready",
  );
  const blocked =
    creation?.failed &&
    !result.entries.some((entry) => entry.creation?.docId === creation.docId);

  return (
    <>
      <MyoxusTitle order={2}>{t.Import()}</MyoxusTitle>
      {blocked ? (
        <Notice
          tone="warning"
          title={t["com.myoxus.diagrams.catalog.create-error"]()}
        >
          <Stack>
            <Text>{creation.title || t.Untitled()}</Text>
            <Button
              onClick={() => {
                onComplete();
                workbench.open(
                  `/diagrams?recoverDiagram=${encodeURIComponent(creation.docId)}`,
                  { at: "active" },
                );
              }}
            >
              {t.Retry()}
            </Button>
          </Stack>
        </Notice>
      ) : null}
      <Accordion
        data-testid="bpmn-import-results"
        defaultValue={String(
          result.entries.findIndex(
            (entry) => entry.inspection.status !== "accepted",
          ),
        )}
      >
        {result.entries.map((entry, index) => {
          const ready = entry.creation?.status === "ready";
          const safe = isPreservableBpmnImport(entry);
          const accepted = entry.inspection.status === "accepted";
          return (
            <AccordionItem key={index} value={String(index)}>
              <AccordionControl>
                <Group>
                  <Text>{entry.file.name}</Text>
                  <Badge
                    tone={
                      ready && accepted ? "success" : safe ? "warning" : "error"
                    }
                  >
                    {ready
                      ? t["com.myoxus.import.status.success.title"]()
                      : !safe
                        ? t["com.myoxus.import.status.failed.title"]()
                        : entry.creation
                          ? t["com.myoxus.diagrams.catalog.create-error"]()
                          : t.Pending()}
                  </Badge>
                </Group>
              </AccordionControl>
              <AccordionPanel>
                <Stack>
                  {ready && !accepted ? (
                    <Text>{t["com.myoxus.editor.bpmn.source-error"]()}</Text>
                  ) : null}
                  {entry.inspection.status !== "accepted" ? (
                    <Text>
                      {bpmnSourceErrorText(t, entry.inspection.error.code)}
                    </Text>
                  ) : null}
                  <Group>
                    <Button
                      variant="secondary"
                      onClick={() => downloadBlob(entry.file, entry.file.name)}
                    >
                      {t["com.myoxus.attachment.download"]()}
                    </Button>
                  </Group>
                </Stack>
              </AccordionPanel>
            </AccordionItem>
          );
        })}
      </Accordion>
      <DialogFooterActions>
        {unfinished ? (
          <Button
            variant="primary"
            disabled={Boolean(blocked)}
            onClick={() => void onRetry()}
          >
            {t.Retry()}
          </Button>
        ) : null}
        <Button
          variant={unfinished ? "secondary" : "primary"}
          onClick={onComplete}
        >
          {t.Complete()}
        </Button>
      </DialogFooterActions>
    </>
  );
}

export function ErrorStatusView({
  error,
  onRetry,
}: {
  error: string | null;
  onRetry: () => void;
}) {
  const t = useI18n();
  return (
    <>
      <MyoxusTitle order={2} textAlign="center" typographySlot="section-title">
        {t["com.myoxus.import.status.failed.title"]()}
      </MyoxusTitle>
      <MyoxusText component="p" textAlign="center" tone="secondary">
        {error || "Unknown error occurred"}
      </MyoxusText>
      <DialogFooterActions>
        <Button onClick={onRetry} variant="primary">
          {t["Retry"]()}
        </Button>
      </DialogFooterActions>
    </>
  );
}
