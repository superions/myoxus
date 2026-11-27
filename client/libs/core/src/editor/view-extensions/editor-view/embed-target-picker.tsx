// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { CoreDocEmbedProvider, DocsService } from "@myoxus/core/modules/doc";
import { GuardService } from "@myoxus/core/modules/permissions";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { useI18n } from "@myoxus/i18n";
import {
  ArrowLeftIcon,
  BlockIcon,
  BlockLinkIcon,
  BulletedListIcon,
  CheckIcon,
  CodeBlockIcon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  Heading4Icon,
  Heading5Icon,
  Heading6Icon,
  ImageIcon,
  PageIcon,
  QuoteIcon,
  TableIcon,
  TocIcon,
} from "@myoxus/icons/react";
import { useLiveData, useServices } from "@myoxus/infra";
import {
  Badge,
  Button,
  CountBadge,
  Divider,
  EmptyState,
  ErrorMessage,
  Group,
  Modal,
  MyoxusLoader,
  MyoxusSegmentedControl,
  MyoxusText,
  NavLink,
  Scrollable,
  SearchInput,
  Stack,
} from "@myoxus/ui-facade";
import { effect } from "@preact/signals-core";
import {
  listSelectableEmbedTargets,
  type SelectableEmbedTarget,
} from "@virgultum/core/adapters";
import type { ReferenceParams } from "@virgultum/core/models";
import { nanoid } from "nanoid";
import { useEffect, useMemo, useState } from "react";

type TargetScope = "all" | "section" | "subtree";

type DraftSelection =
  { kind: "whole" } | { kind: "section" | "subtree"; blockId: string };

type LoadedTargetState = {
  key: string;
  loading: boolean;
  error: boolean;
  title: string;
  targets: SelectableEmbedTarget[];
};

function draftFromParams(params?: ReferenceParams): DraftSelection {
  const blockId = params?.blockIds?.length === 1 ? params.blockIds[0] : "";
  if (!blockId) return { kind: "whole" };
  return {
    kind: params?.blockSelection === "section" ? "section" : "subtree",
    blockId,
  };
}

function paramsFromDraft(draft: DraftSelection): ReferenceParams | undefined {
  if (draft.kind === "whole") return undefined;
  return {
    mode: "page",
    blockIds: [draft.blockId],
    blockSelection: draft.kind,
  };
}

function HeadingIcon({ level }: { level?: number }) {
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
    case 6:
      return <Heading6Icon aria-hidden />;
    default:
      return <BlockLinkIcon aria-hidden />;
  }
}

function TargetIcon({ target }: { target: SelectableEmbedTarget }) {
  if (target.selectionKind === "section") {
    return <HeadingIcon level={target.headingLevel} />;
  }
  switch (target.flavour) {
    case "myoxus:list":
      return <BulletedListIcon aria-hidden />;
    case "myoxus:code":
      return <CodeBlockIcon aria-hidden />;
    case "myoxus:table":
      return <TableIcon aria-hidden />;
    case "myoxus:image":
      return <ImageIcon aria-hidden />;
    case "myoxus:callout":
      return <QuoteIcon aria-hidden />;
    case "myoxus:table-of-contents":
      return <TocIcon aria-hidden />;
    default:
      return <BlockIcon aria-hidden />;
  }
}

function useAuthorizedEmbedTargets(
  pageId: string | null,
  workspaceId?: string,
): LoadedTargetState {
  const { guardService, docsService, workspaceService } = useServices({
    GuardService,
    DocsService,
    WorkspaceService,
  });
  const key = `${workspaceId ?? ""}:${pageId ?? ""}`;
  const [state, setState] = useState<LoadedTargetState>({
    key,
    loading: !!pageId,
    error: false,
    title: "",
    targets: [],
  });

  useEffect(() => {
    if (!pageId) {
      setState({
        key,
        loading: false,
        error: false,
        title: "",
        targets: [],
      });
      return;
    }
    const workspace = workspaceService.workspace;
    const provider = new CoreDocEmbedProvider(
      guardService,
      docsService,
      workspace,
    );
    const binding = provider.openReference(workspaceId, pageId);
    const stop = effect(() => {
      const target = binding.target.value;
      const allowed = target?.access.readable(target.docId).value;
      if (!target || allowed !== true) {
        setState({
          key,
          loading: target === undefined || (!!target && allowed === undefined),
          error: target === null || allowed === false,
          title: "",
          targets: [],
        });
        return;
      }
      const currentTitle =
        target.access.referenceTitleSignal?.(target.docId)?.value ?? "";
      const attempt = new AbortController();
      const signal = AbortSignal.any([
        attempt.signal,
        AbortSignal.timeout(30_000),
      ]);
      let release: (() => void) | undefined;
      const live = () =>
        !attempt.signal.aborted &&
        binding.target.peek() === target &&
        target.access.readable(target.docId).peek() === true;

      setState({
        key,
        loading: true,
        error: false,
        title: currentTitle,
        targets: [],
      });

      void target.access
        .waitForLoaded(target.docId, signal)
        .then(() => {
          if (!live()) return;
          const doc = target.collection.getDoc(target.docId);
          if (!doc) {
            setState({
              key,
              loading: false,
              error: true,
              title: "",
              targets: [],
            });
            return;
          }
          const options = { id: nanoid(), readonly: true };
          const store = doc.getStore(options);
          const readTargets = () => {
            if (!live()) return;
            const transformer = store.getTransformer([]);
            try {
              const snapshot = transformer.docToSnapshot(store);
              if (!snapshot) {
                setState({
                  key,
                  loading: false,
                  error: true,
                  title: currentTitle,
                  targets: [],
                });
                return;
              }
              const authorizedTitles = new Map<string, string>();
              for (const meta of target.collection.meta.docMetas) {
                if (target.access.readable(meta.id).peek() === true) {
                  authorizedTitles.set(meta.id, meta.title || "");
                }
              }
              setState({
                key,
                loading: false,
                error: false,
                title:
                  target.access.referenceTitleSignal?.(target.docId)?.peek() ??
                  currentTitle,
                targets: listSelectableEmbedTargets(
                  snapshot.blocks,
                  authorizedTitles,
                ),
              });
            } catch {
              setState({
                key,
                loading: false,
                error: true,
                title: "",
                targets: [],
              });
            } finally {
              transformer[Symbol.dispose]();
            }
          };
          release = () => {
            store.spaceDoc.off("afterTransaction", readTargets);
            store.dispose();
            doc.removeStore(options);
          };
          store.load();
          store.spaceDoc.on("afterTransaction", readTargets);
          readTargets();
        })
        .catch(() => {
          if (live()) {
            setState({
              key,
              loading: false,
              error: true,
              title: "",
              targets: [],
            });
          }
        });

      return () => {
        attempt.abort();
        release?.();
      };
    });
    return () => {
      stop();
      binding.dispose();
      provider.dispose();
    };
  }, [key, pageId, workspaceId, guardService, docsService, workspaceService]);

  return state.key === key
    ? state
    : { key, loading: !!pageId, error: false, title: "", targets: [] };
}

function TargetSelectionBody({
  pageId,
  workspaceId,
  initialParams,
  onChangeDocument,
  onApply,
  onCancel,
}: {
  pageId: string;
  workspaceId?: string;
  initialParams?: ReferenceParams;
  onChangeDocument?: () => void;
  onApply: (params: ReferenceParams | undefined) => void;
  onCancel: () => void;
}) {
  const t = useI18n();
  const loaded = useAuthorizedEmbedTargets(pageId, workspaceId);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<TargetScope>("all");
  const [draft, setDraft] = useState<DraftSelection>(() =>
    draftFromParams(initialParams),
  );

  useEffect(() => {
    setDraft(draftFromParams(initialParams));
    setQuery("");
    setScope("all");
  }, [pageId, workspaceId, initialParams]);

  const counts = useMemo(() => {
    let sections = 0;
    let blocks = 0;
    for (const item of loaded.targets) {
      if (item.selectionKind === "section") sections++;
      else blocks++;
    }
    return { total: loaded.targets.length, sections, blocks };
  }, [loaded.targets]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return loaded.targets.filter((item) => {
      if (scope !== "all" && item.selectionKind !== scope) return false;
      if (!normalized) return true;
      const haystack = [
        item.label,
        ...(item.headingPath ?? []),
        item.headingLevel ? `h${item.headingLevel}` : "",
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(normalized);
    });
  }, [loaded.targets, query, scope]);

  const isWholeSelected = draft.kind === "whole";
  const canConfirm = !loaded.loading && !loaded.error;

  return (
    <Stack gap="sm" data-testid="embed-target-picker">
      <Group justify="space-between" wrap="nowrap">
        <Group gap="xs" wrap="nowrap" miw={0}>
          <PageIcon aria-hidden />
          <MyoxusText typographySlot="body-small" truncate>
            <strong>{loaded.title || t["Untitled"]()}</strong>
          </MyoxusText>
        </Group>
        {onChangeDocument ? (
          <Button
            variant="plain"
            prefix={<ArrowLeftIcon aria-hidden />}
            onClick={onChangeDocument}
          >
            {t["com.myoxus.wiki.embed.change-source"]()}
          </Button>
        ) : null}
      </Group>

      {loaded.loading ? (
        <Group justify="center" py="lg">
          <MyoxusLoader />
        </Group>
      ) : loaded.error ? (
        <ErrorMessage>{t["com.myoxus.wiki.embed.unavailable"]()}</ErrorMessage>
      ) : (
        <>
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder={t["com.myoxus.wiki.embed.filter-placeholder"]()}
            autoFocus
            data-testid="embed-target-search"
          />

          <MyoxusSegmentedControl
            layout="fluid"
            value={scope}
            onChange={(next) => {
              if (next === "all" || next === "section" || next === "subtree") {
                setScope(next);
              }
            }}
            data={[
              {
                value: "all",
                testId: "embed-target-scope-all",
                label: (
                  <CountBadge
                    label={t["com.myoxus.wiki.embed.scope-all"]()}
                    count={counts.total}
                  />
                ),
              },
              {
                value: "section",
                testId: "embed-target-scope-section",
                label: (
                  <CountBadge
                    label={t["com.myoxus.wiki.embed.scope-sections"]()}
                    count={counts.sections}
                  />
                ),
              },
              {
                value: "subtree",
                testId: "embed-target-scope-subtree",
                label: (
                  <CountBadge
                    label={t["com.myoxus.wiki.embed.scope-blocks"]()}
                    count={counts.blocks}
                  />
                ),
              },
            ]}
          />

          <NavLink
            component="button"
            type="button"
            active={isWholeSelected}
            label={t["com.myoxus.wiki.embed.whole-document"]()}
            description={t["com.myoxus.wiki.embed.whole-document-hint"]()}
            leftSection={<PageIcon aria-hidden />}
            rightSection={isWholeSelected ? <CheckIcon aria-hidden /> : null}
            onClick={() => setDraft({ kind: "whole" })}
            onDoubleClick={() => onApply(undefined)}
            data-testid="embed-target-whole"
          />

          <Divider />

          {filtered.length === 0 ? (
            <EmptyState
              title={t["com.myoxus.wiki.embed.empty-targets"]()}
              media={<BlockLinkIcon aria-hidden />}
            />
          ) : (
            <Scrollable.Viewport maxHeight="floating" scrollbars="y">
              <Stack gap={2}>
                {filtered.map((item) => {
                  const active =
                    draft.kind !== "whole" &&
                    draft.blockId === item.blockId &&
                    draft.kind === item.selectionKind;
                  const breadcrumb =
                    item.selectionKind === "section"
                      ? item.headingPath && item.headingPath.length > 1
                        ? item.headingPath.slice(0, -1).join(" › ")
                        : undefined
                      : item.headingPath?.join(" › ");
                  return (
                    <NavLink
                      key={`${item.selectionKind}:${item.blockId}`}
                      component="button"
                      type="button"
                      active={active}
                      label={item.label}
                      description={breadcrumb}
                      leftSection={<TargetIcon target={item} />}
                      rightSection={
                        <Group gap="xs" wrap="nowrap">
                          <Badge
                            tone={
                              item.selectionKind === "section"
                                ? "info"
                                : "neutral"
                            }
                          >
                            {item.selectionKind === "section" &&
                            item.headingLevel
                              ? `H${item.headingLevel}`
                              : t["com.myoxus.wiki.embed.badge-block"]()}
                          </Badge>
                          {active ? <CheckIcon aria-hidden /> : null}
                        </Group>
                      }
                      onClick={() =>
                        setDraft({
                          kind: item.selectionKind,
                          blockId: item.blockId,
                        })
                      }
                      onDoubleClick={() =>
                        onApply(
                          paramsFromDraft({
                            kind: item.selectionKind,
                            blockId: item.blockId,
                          }),
                        )
                      }
                      data-testid={`embed-target-option-${item.selectionKind}-${item.blockId}`}
                    />
                  );
                })}
              </Stack>
            </Scrollable.Viewport>
          )}
        </>
      )}

      <Group justify="flex-end" gap="xs">
        <Button variant="secondary" onClick={onCancel}>
          {t["Cancel"]()}
        </Button>
        <Button
          variant="primary"
          disabled={!canConfirm}
          onClick={() => onApply(paramsFromDraft(draft))}
          data-testid="embed-target-apply"
        >
          {t["Save"]()}
        </Button>
      </Group>
    </Stack>
  );
}

/** Edit or choose a target (whole document, section, or block) for an existing synced embed. */
export function EmbedTargetPickerModal({
  pageId,
  workspaceId,
  params,
  apply,
  close,
}: {
  pageId: string;
  workspaceId?: string;
  params?: ReferenceParams;
  apply: (nextParams: ReferenceParams | undefined) => void;
  close: () => void;
}) {
  const t = useI18n();
  return (
    <Modal
      open
      width="md"
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={t["com.myoxus.wiki.embed.select-content"]()}
    >
      <TargetSelectionBody
        pageId={pageId}
        workspaceId={workspaceId}
        initialParams={params}
        onApply={apply}
        onCancel={close}
      />
    </Modal>
  );
}

/** Two-step modal for inserting a live section or block embed from Slash or PagePicker. */
export function EmbedSectionInsertModal({
  currentDocId,
  initialDocId,
  insert,
  close,
}: {
  currentDocId: string;
  initialDocId?: string;
  insert: (pageId: string, params: ReferenceParams | undefined) => void;
  close: () => void;
}) {
  const t = useI18n();
  const { docsService, guardService } = useServices({
    DocsService,
    GuardService,
  });
  const docs = useLiveData(docsService.list.docs$);
  const [selectedDocId, setSelectedDocId] = useState<string | null>(
    initialDocId ?? null,
  );
  const [docQuery, setDocQuery] = useState("");

  const readableDocs = useMemo(() => {
    const normalized = docQuery.trim().toLowerCase();
    return docs
      .filter((doc) => {
        if (doc.id === currentDocId) return false;
        if (doc.trash$.value) return false;
        if (guardService.can$("Doc_Read", doc.id).signal.value === false) {
          return false;
        }
        const title = (doc.title$.value || t["Untitled"]()).toLowerCase();
        return !normalized || title.includes(normalized);
      })
      .slice(0, 100);
  }, [docs, currentDocId, docQuery, guardService, t]);

  return (
    <Modal
      open
      width="md"
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={
        selectedDocId
          ? t["com.myoxus.wiki.embed.select-content"]()
          : t["com.myoxus.wiki.embed.title"]()
      }
    >
      {selectedDocId ? (
        <TargetSelectionBody
          pageId={selectedDocId}
          onChangeDocument={
            initialDocId ? undefined : () => setSelectedDocId(null)
          }
          onApply={(params) => insert(selectedDocId, params)}
          onCancel={close}
        />
      ) : (
        <Stack gap="sm" data-testid="embed-source-doc-picker">
          <MyoxusText typographySlot="body-small" tone="secondary">
            {t["com.myoxus.wiki.embed.choose-source"]()}
          </MyoxusText>
          <SearchInput
            value={docQuery}
            onChange={setDocQuery}
            placeholder={t["com.myoxus.wiki.embed.search-documents"]()}
            autoFocus
            data-testid="embed-source-doc-search"
          />
          {readableDocs.length === 0 ? (
            <EmptyState
              title={t["com.myoxus.wiki.embed.empty-targets"]()}
              media={<PageIcon aria-hidden />}
            />
          ) : (
            <Scrollable.Viewport maxHeight="floating" scrollbars="y">
              <Stack gap={2}>
                {readableDocs.map((doc) => {
                  const title = doc.title$.value || t["Untitled"]();
                  return (
                    <NavLink
                      key={doc.id}
                      component="button"
                      type="button"
                      label={title}
                      leftSection={<PageIcon aria-hidden />}
                      onClick={() => setSelectedDocId(doc.id)}
                      data-testid={`embed-source-doc-${doc.id}`}
                    />
                  );
                })}
              </Stack>
            </Scrollable.Viewport>
          )}
          <Group justify="flex-end">
            <Button variant="secondary" onClick={close}>
              {t["Cancel"]()}
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
