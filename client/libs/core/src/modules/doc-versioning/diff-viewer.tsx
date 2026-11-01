// SPDX-License-Identifier: AGPL-3.0-or-later
import type { GraphQLService } from "@myoxus/core/modules/server";
import type { Workspace } from "@myoxus/core/modules/workspace";
import { useRegionalFormatters } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import { useI18n } from "@myoxus/i18n";
import {
  Button,
  DiffInlineText,
  Group,
  Loading,
  MyoxusText,
  MyoxusTitle,
  SettingsNotice,
  Stack,
} from "@myoxus/ui-facade";

import { useHistoryComparison } from "./history-data";

export interface DocumentVersionDiffViewerProps {
  visible: boolean;
  workspace: Workspace;
  docId: string;
  snapshotId: string;
  captureTime?: string;
  label?: string;
  graphqlService: GraphQLService;
}

const noticeKeys = {
  presentation_not_compared: "com.myoxus.history.comparison.presentation",
  unsupported_content: "com.myoxus.history.comparison.unsupported",
  partial_extraction: "com.myoxus.history.comparison.partial",
  incomplete_structure: "com.myoxus.history.comparison.incomplete",
  structure_changed: "com.myoxus.history.comparison.structure",
  ambiguous_removal_anchor: "com.myoxus.history.comparison.anchor",
} as const;

/** Readable server projection, never marks on either Yjs document. */
export function DocumentVersionDiffViewer({
  visible,
  workspace,
  docId,
  snapshotId,
  captureTime,
  label,
  graphqlService,
}: DocumentVersionDiffViewerProps) {
  const t = useI18n();
  const { formatDateTime } = useRegionalFormatters();
  const { comparison, loading, pending, error, retry } = useHistoryComparison(
    graphqlService,
    workspace,
    docId,
    snapshotId,
    visible,
  );
  const added = t["com.myoxus.history.comparison.added"]();
  const removed = t["com.myoxus.history.comparison.removed"]();
  const notices = new Set<keyof typeof noticeKeys>(
    comparison?.notices.map(({ kind }) => kind),
  );
  if (comparison?.extractionPartial) notices.add("partial_extraction");
  const hasTextChanges = comparison?.comparisonBlocks.some((block) =>
    block.runs.some((run) => run.kind !== "unchanged"),
  );
  return (
    <Stack
      component="section"
      data-testid="history-current-comparison"
      aria-label={t["com.myoxus.history.mode.changes"]()}
    >
      {captureTime ? (
        <MyoxusTitle order={3}>
          {t["com.myoxus.history.comparison.selected"]({
            time: formatDateTime(captureTime),
          })}
        </MyoxusTitle>
      ) : null}
      {label ? <MyoxusText>{label}</MyoxusText> : null}
      <MyoxusTitle order={4}>
        {t["com.myoxus.history.comparison.current"]()}
      </MyoxusTitle>
      <Group>
        <DiffInlineText tone="added" label={added}>
          + {added}
        </DiffInlineText>
        <DiffInlineText tone="removed" label={removed}>
          − {removed}
        </DiffInlineText>
      </Group>
      {pending ? (
        <SettingsNotice>
          {t["com.myoxus.history.comparison.pending"]()}
        </SettingsNotice>
      ) : null}
      {error ? (
        <SettingsNotice tone="error">
          {error instanceof Error
            ? error.message
            : t["com.myoxus.sidebar.document-versions.diff.compare-failed"]()}
          <Button onClick={() => void retry()}>{t["Retry"]()}</Button>
        </SettingsNotice>
      ) : null}
      {error && comparison ? (
        <SettingsNotice>
          {t["com.myoxus.history.comparison.stale"]()}
        </SettingsNotice>
      ) : null}
      {loading ? (
        comparison ? (
          <SettingsNotice>
            {t["com.myoxus.history.comparison.refreshing"]()}
          </SettingsNotice>
        ) : (
          <Loading />
        )
      ) : null}
      {comparison ? (
        <>
          <MyoxusText
            tone="secondary"
            data-current-revision={comparison.currentRevision}
            data-server-read-at={comparison.readAt}
          >
            {t["com.myoxus.history.comparison.read"]({
              time: formatDateTime(comparison.readAt),
              revision: new Intl.NumberFormat(t.language).format(
                BigInt(comparison.currentRevision),
              ),
            })}
          </MyoxusText>
          {[...notices].map((kind) => (
            <SettingsNotice
              key={kind}
              tone={kind === "presentation_not_compared" ? "info" : "warning"}
            >
              {t[noticeKeys[kind]]()}
            </SettingsNotice>
          ))}
          {!hasTextChanges ? (
            <SettingsNotice>
              {t["com.myoxus.history.comparison.no-text"]()}
            </SettingsNotice>
          ) : null}
          {comparison.comparisonBlocks
            .filter((block) => block.runs.some((run) => run.text))
            .map((block) => (
              <MyoxusText
                component="p"
                key={block.blockId}
                data-comparison-block={block.blockId}
                data-placement-known={block.placementKnown}
              >
                {block.runs.map((run, index) => (
                  <DiffInlineText
                    key={index}
                    tone={run.kind}
                    label={
                      run.kind === "added"
                        ? `${added}: ${run.text}`
                        : run.kind === "removed"
                          ? `${removed}: ${run.text}`
                          : undefined
                    }
                  >
                    {run.text}
                  </DiffInlineText>
                ))}
              </MyoxusText>
            ))}
        </>
      ) : null}
    </Stack>
  );
}
