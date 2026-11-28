// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { DocsService } from "@myoxus/core/modules/doc";
import { GuardService } from "@myoxus/core/modules/permissions";
import { useI18n } from "@myoxus/i18n";
import {
  DeleteIcon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  Heading4Icon,
  Heading5Icon,
  Heading6Icon,
  SettingsIcon,
  TocIcon,
} from "@myoxus/icons/react";
import { useServiceOptional } from "@myoxus/infra";
import {
  Badge,
  Box,
  Button,
  Divider,
  FormSelect,
  Group,
  Input,
  Modal,
  MyoxusText,
  NavLink,
  Paper,
  Stack,
  Tooltip,
} from "@myoxus/ui-facade";
import {
  normalizeTocLevelRange,
  type TableOfContentsBlockModel,
  type TableOfContentsProps,
  type TocHeadingLevel,
} from "@virgultum/core/models";
import {
  describeOutlineBlockFromStore,
  getOutlineHeadingLevel,
  getReadablePageHeadingBlocksFromStore,
} from "@virgultum/core/utils";
import { useEffect, useMemo, useRef, useState } from "react";
import { scrollToPageBlockWithHighlight } from "../../virgultum/doc-editor/page-outline-controller";

const LEVEL_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "1", label: "H1" },
  { value: "2", label: "H2" },
  { value: "3", label: "H3" },
  { value: "4", label: "H4" },
  { value: "5", label: "H5" },
  { value: "6", label: "H6" },
];

function HeadingLevelIcon({ level }: { level: number }) {
  switch (level) {
    case 1:
      return <Heading1Icon aria-hidden />;
    case 2:
      return <Heading2Icon aria-hidden />;
    case 3:
      return <Heading3Icon aria-hidden />;
    case 4:
      return <Heading4Icon aria-hidden />;
    case 5:
      return <Heading5Icon aria-hidden />;
    default:
      return <Heading6Icon aria-hidden />;
  }
}

function formatRangeBadge(minLevel: number, maxLevel: number): string {
  return minLevel === maxLevel ? `H${minLevel}` : `H${minLevel}–H${maxLevel}`;
}

function indentMargin(depth: number): "md" | "xl" | undefined {
  if (depth <= 0) return undefined;
  if (depth === 1) return "md";
  return "xl";
}

export function TableOfContentsConfiguration({
  value,
  matchingCount,
  apply,
  close,
}: {
  value: TableOfContentsProps;
  matchingCount?: (
    minLevel: TocHeadingLevel,
    maxLevel: TocHeadingLevel,
  ) => number;
  apply: (next: TableOfContentsProps) => void;
  close: () => void;
}) {
  const t = useI18n();
  const initialRange = normalizeTocLevelRange(value.minLevel, value.maxLevel);
  const [title, setTitle] = useState(value.title ?? "");
  const [minLevel, setMinLevel] = useState<TocHeadingLevel>(
    initialRange.minLevel,
  );
  const [maxLevel, setMaxLevel] = useState<TocHeadingLevel>(
    initialRange.maxLevel,
  );

  const count = matchingCount ? matchingCount(minLevel, maxLevel) : undefined;

  return (
    <Modal
      open
      width="sm"
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={t["com.myoxus.wiki.toc.configure"]()}
    >
      <Stack gap="sm" data-testid="toc-configuration-modal">
        <Input
          label={t["Title"]()}
          placeholder={t["com.myoxus.wiki.toc.title"]()}
          value={title}
          onChange={setTitle}
          data-testid="toc-title-input"
        />
        <Group grow>
          <FormSelect
            label={t["com.myoxus.wiki.toc.min-level"]()}
            value={String(minLevel)}
            data={LEVEL_OPTIONS}
            onChange={(next) => {
              if (!next) return;
              const parsed = Number(next) as TocHeadingLevel;
              const normalized = normalizeTocLevelRange(
                parsed,
                parsed > maxLevel ? parsed : maxLevel,
              );
              setMinLevel(normalized.minLevel);
              setMaxLevel(normalized.maxLevel);
            }}
            data-testid="toc-min-level-select"
          />
          <FormSelect
            label={t["com.myoxus.wiki.toc.max-level"]()}
            value={String(maxLevel)}
            data={LEVEL_OPTIONS}
            onChange={(next) => {
              if (!next) return;
              const parsed = Number(next) as TocHeadingLevel;
              const normalized = normalizeTocLevelRange(
                parsed < minLevel ? parsed : minLevel,
                parsed,
              );
              setMinLevel(normalized.minLevel);
              setMaxLevel(normalized.maxLevel);
            }}
            data-testid="toc-max-level-select"
          />
        </Group>
        {count !== undefined ? (
          <MyoxusText typographySlot="dense-label" tone="secondary">
            {t["com.myoxus.wiki.toc.matching-count"]({ count: String(count) })}
          </MyoxusText>
        ) : null}
        <Group justify="flex-end" gap="xs">
          <Button variant="secondary" onClick={close}>
            {t["Cancel"]()}
          </Button>
          <Button
            variant="primary"
            onClick={() =>
              apply({
                title: title.trim(),
                minLevel,
                maxLevel,
              })
            }
            data-testid="toc-config-save"
          >
            {t["Save"]()}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/**
 * Shared AGPL Mantine/Facade in-body Table of Contents block rendered inside
 * `VirgultumPageEditor`, `PageSnapshot` (read-only/embedded), and Canvas Notes.
 * Performs zero Yjs writes on mount or live refresh.
 */
export function TableOfContentsBlock({
  model,
  readonly = false,
  embedded = false,
  onNavigate,
}: {
  model: TableOfContentsBlockModel;
  readonly?: boolean;
  embedded?: boolean;
  onNavigate?: (blockId: string) => void;
}) {
  const t = useI18n();
  const docsService = useServiceOptional(DocsService);
  const guardService = useServiceOptional(GuardService);
  const rootRef = useRef<HTMLDivElement>(null);
  const [revision, setRevision] = useState(0);
  const [configuring, setConfiguring] = useState(false);

  useEffect(() => {
    const spaceDoc = model.store.spaceDoc;
    const bump = () => setRevision((value) => value + 1);
    spaceDoc.on("afterTransaction", bump);
    return () => {
      spaceDoc.off("afterTransaction", bump);
    };
  }, [model.store]);

  const range = normalizeTocLevelRange(
    model.props.minLevel,
    model.props.maxLevel,
  );
  const canEdit = !readonly && !embedded && !model.store.readonly;

  const entries = useMemo(() => {
    void revision;
    const headings = getReadablePageHeadingBlocksFromStore(model.store, {
      minLevel: range.minLevel,
      maxLevel: range.maxLevel,
      ignoreEmpty: true,
    });
    const out: Array<{ id: string; level: number; label: string }> = [];
    for (const block of headings) {
      const level = getOutlineHeadingLevel(block);
      if (level === undefined) continue;
      const described = describeOutlineBlockFromStore(block, {
        resolveReference: (pageId, workspaceId) => {
          if (workspaceId && workspaceId !== model.store.workspace.id) {
            return {
              text: t["com.myoxus.reference.target-unavailable"](),
              unavailable: true,
            };
          }
          const allowed =
            guardService?.can$("Doc_Read", pageId).signal.value ?? true;
          if (!allowed) {
            return {
              text: t["com.myoxus.reference.target-unavailable"](),
              unavailable: true,
            };
          }
          const meta = docsService?.list.doc$(pageId).value;
          const title = meta?.title$.value?.trim();
          return title
            ? { text: title, docId: pageId }
            : {
                text: t["Untitled"](),
                docId: pageId,
              };
        },
      });
      if (!described?.label.trim()) continue;
      out.push({
        id: block.id,
        level,
        label: described.label.trim(),
      });
    }
    return out;
  }, [
    revision,
    model.store,
    range.minLevel,
    range.maxLevel,
    docsService,
    guardService,
    t,
  ]);

  const minPresentLevel = entries.length
    ? Math.min(...entries.map((entry) => entry.level))
    : range.minLevel;

  const handleNavigate = (blockId: string) => {
    if (embedded) return;
    if (onNavigate) {
      onNavigate(blockId);
      return;
    }
    const origin =
      rootRef.current?.closest<HTMLElement>("[data-page-renderer]") ?? null;
    scrollToPageBlockWithHighlight(origin, blockId, model.store.root?.id);
  };

  const handleApply = (next: TableOfContentsProps) => {
    if (
      canEdit &&
      model.store.getModelById(model.id) === model &&
      !model.store.readonly
    ) {
      model.store.captureSync();
      model.store.updateBlock(model, next);
      model.store.captureSync();
    }
    setConfiguring(false);
  };

  const handleDelete = () => {
    if (
      canEdit &&
      model.store.getModelById(model.id) === model &&
      !model.store.readonly
    ) {
      model.store.captureSync();
      model.store.deleteBlock(model);
      model.store.captureSync();
    }
  };

  const headingTitle =
    model.props.title?.trim() || t["com.myoxus.wiki.toc.title"]();

  return (
    <Box
      ref={rootRef}
      my="sm"
      data-testid="table-of-contents-block"
      data-toc-block-id={model.id}
    >
      <Paper withBorder radius="md" p="md">
        <Stack gap="xs">
          <Group justify="space-between" wrap="nowrap" gap="xs">
            <Group gap="xs" wrap="nowrap" miw={0}>
              <TocIcon aria-hidden />
              <MyoxusText typographySlot="card-title" truncate>
                <strong>{headingTitle}</strong>
              </MyoxusText>
              <Badge tone="neutral" data-testid="toc-range-badge">
                {formatRangeBadge(range.minLevel, range.maxLevel)}
              </Badge>
            </Group>
            {canEdit ? (
              <Group gap="xs" wrap="nowrap">
                <Tooltip content={t["com.myoxus.wiki.toc.configure"]()}>
                  <Button
                    variant="plain"
                    prefix={<SettingsIcon aria-hidden />}
                    onClick={() => setConfiguring(true)}
                    aria-label={t["com.myoxus.wiki.toc.configure"]()}
                    data-testid="toc-configure-button"
                  >
                    {t["Edit"]()}
                  </Button>
                </Tooltip>
                <Tooltip content={t["Delete"]()}>
                  <Button
                    variant="plain"
                    prefix={<DeleteIcon aria-hidden />}
                    onClick={handleDelete}
                    aria-label={t["Delete"]()}
                    data-testid="toc-delete-button"
                  />
                </Tooltip>
              </Group>
            ) : null}
          </Group>

          <Divider />

          {entries.length === 0 ? (
            <MyoxusText
              typographySlot="body-small"
              tone="secondary"
              data-testid="toc-empty-state"
            >
              {canEdit
                ? t["com.myoxus.wiki.toc.empty-author"]()
                : t["com.myoxus.wiki.toc.empty-reader"]()}
            </MyoxusText>
          ) : (
            <Stack gap={2} component="nav" aria-label={headingTitle}>
              {entries.map((entry) => {
                const depth = Math.max(0, entry.level - minPresentLevel);
                return (
                  <Box key={entry.id} ml={indentMargin(depth)}>
                    <NavLink
                      component="button"
                      type="button"
                      label={entry.label}
                      leftSection={<HeadingLevelIcon level={entry.level} />}
                      disabled={embedded}
                      onClick={() => handleNavigate(entry.id)}
                      data-testid={`toc-entry-${entry.id}`}
                    />
                  </Box>
                );
              })}
            </Stack>
          )}
        </Stack>
      </Paper>

      {configuring && canEdit ? (
        <TableOfContentsConfiguration
          value={{
            title: model.props.title ?? "",
            minLevel: range.minLevel,
            maxLevel: range.maxLevel,
          }}
          matchingCount={(min, max) =>
            getReadablePageHeadingBlocksFromStore(model.store, {
              minLevel: min,
              maxLevel: max,
              ignoreEmpty: true,
            }).length
          }
          apply={handleApply}
          close={() => setConfiguring(false)}
        />
      ) : null}
    </Box>
  );
}
