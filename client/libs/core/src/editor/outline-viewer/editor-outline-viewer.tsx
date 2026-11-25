// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { DocDisplayMetaService } from "@myoxus/core/modules/doc-display-meta";
import { GuardService } from "@myoxus/core/modules/permissions";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { useI18n } from "@myoxus/i18n";
import { TocIcon } from "@myoxus/icons/react";
import { useServiceOptional } from "@myoxus/infra";
import {
  Box,
  EditorOutlineFloatingFrame,
  Group,
  IconButton,
  MyoxusText,
  Popover,
  PopoverContent,
  PopoverTarget,
  Scrollable,
  Stack,
  TableOfContents,
} from "@myoxus/ui-facade";
import { NoteDisplayMode } from "@virgultum/core/models";
import type { EditorOutlineEntry } from "@virgultum/core/services";
import type { Store } from "@virgultum/core/store";
import {
  describeOutlineBlockFromStore,
  getOutlineHeadingBlocksFromDoc,
} from "@virgultum/core/utils";
import type { EditorHost } from "@virgultum/editor/std";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

import { scrollToPageBlockWithHighlight } from "../virgultum/doc-editor/page-outline-controller";

const PAGE_NOTE_MODES = [
  NoteDisplayMode.DocAndEdgeless,
  NoteDisplayMode.DocOnly,
] as const;

function resolveBlockId(element: HTMLElement | null): string | null {
  if (!element) return null;
  return (
    element.getAttribute("data-block-id") ??
    element.getAttribute("data-page-text") ??
    null
  );
}

export interface EditorOutlineViewerProps {
  doc?: Store | null;
  editor?: EditorHost | null;
  show: boolean;
  openOutlinePanel?: () => void;
  origin?: HTMLElement | null;
}

/**
 * Pure-Store floating Table of Contents for Share and Peek views.
 * Backed by the shared `@virgultum/core/utils` heading model and Facade
 * `TableOfContents` + `Popover` (keyboard- and mouse-accessible).
 */
export const EditorOutlineViewer = ({
  doc,
  editor,
  show,
  openOutlinePanel,
  origin,
}: EditorOutlineViewerProps) => {
  const store = doc ?? editor?.store ?? null;
  const t = useI18n();
  const displayMeta = useServiceOptional(DocDisplayMetaService);
  const guard = useServiceOptional(GuardService);
  const workspaceService = useServiceOptional(WorkspaceService);
  const [revision, bump] = useReducer((n: number) => n + 1, 0);
  const [opened, setOpened] = useState(false);
  const [pinned, setPinned] = useState(false);
  const reinitializeRef = useRef<() => void>(() => {});
  const clearHighlightRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!store || !show) return;
    const blockSub = store.slots.blockUpdated.subscribe(bump);
    const metaSub = store.workspace.meta.docMetaUpdated.subscribe(bump);
    store.spaceDoc.on("afterTransaction", bump);
    return () => {
      blockSub.unsubscribe();
      metaSub.unsubscribe();
      store.spaceDoc.off("afterTransaction", bump);
      clearHighlightRef.current();
      clearHighlightRef.current = () => {};
    };
  }, [store, show]);

  const resolveMessage = useCallback(
    (key: string, fallback: string) => {
      const fn = (t as unknown as Record<string, (() => string) | undefined>)[
        key
      ];
      return typeof fn === "function" ? fn() : fallback;
    },
    [t],
  );

  const resolveReference = useCallback(
    (pageId: string, workspaceId?: string) => {
      const currentWorkspaceId =
        workspaceService?.workspace.id ?? store?.workspace.id;
      const meta = store?.workspace.meta.docMetas.find((d) => d.id === pageId);
      const readable =
        meta &&
        (!workspaceId || workspaceId === currentWorkspaceId) &&
        (guard ? guard.can$("Doc_Read", pageId).value !== false : true);
      if (!readable) {
        return {
          text: t["com.myoxus.reference.target-unavailable"](),
          unavailable: true,
        };
      }
      const title =
        displayMeta?.title$(pageId).value || meta?.title || t["Untitled"]();
      return { text: title, docId: pageId };
    },
    [displayMeta, guard, store, t, workspaceService],
  );

  const entries = useMemo<EditorOutlineEntry[]>(() => {
    void revision;
    if (!store || !show || !store.root) return [];
    const headings = getOutlineHeadingBlocksFromDoc(
      store,
      PAGE_NOTE_MODES,
      true,
    );
    if (!headings.length) return [];

    const blocks = [...(store.meta?.title ? [store.root] : []), ...headings];
    return blocks.flatMap(
      (block) =>
        describeOutlineBlockFromStore(block, {
          resolveReference,
          resolveMessage,
        }) ?? [],
    );
  }, [revision, store, show, resolveReference, resolveMessage]);

  const entryById = useMemo(
    () => new Map(entries.map((entry) => [entry.id, entry])),
    [entries],
  );

  const selector = useMemo(() => {
    if (!entries.length) return "";
    return entries
      .map((entry) => {
        const escaped = CSS.escape(entry.id);
        return `[data-block-id="${escaped}"]`;
      })
      .join(", ");
  }, [entries]);

  const initialData = useMemo(
    () =>
      entries.map((entry) => ({
        id: entry.id,
        depth: entry.level + 1,
        value: entry.label,
      })),
    [entries],
  );

  useEffect(() => {
    if (opened && entries.length) {
      reinitializeRef.current();
    }
  }, [opened, entries]);

  const navigate = useCallback(
    (blockId: string) => {
      if (!store) return;
      clearHighlightRef.current();
      clearHighlightRef.current = scrollToPageBlockWithHighlight(
        origin ?? editor ?? null,
        blockId,
        store.root?.id,
      );
    },
    [editor, origin, store],
  );

  if (!store || !show || !entries.length) return null;

  const title = t["com.myoxus.sidebar.outline.title"]();
  const openSidebarLabel = t["com.myoxus.editor.outline.open-in-sidebar"]();

  return (
    <EditorOutlineFloatingFrame>
      <Box
        onMouseEnter={() => setOpened(true)}
        onMouseLeave={() => {
          if (!pinned) setOpened(false);
        }}
      >
        <Popover
          withinPortal={false}
          opened={opened}
          onChange={(next) => {
            setOpened(next);
            if (!next) setPinned(false);
          }}
          position="left-start"
        >
          <PopoverTarget>
            <IconButton
              aria-label={title}
              aria-expanded={opened}
              tooltip={title}
              data-testid="outline-viewer-trigger"
              onClick={() => {
                setPinned((prev) => {
                  const next = !prev;
                  setOpened(next);
                  return next;
                });
              }}
            >
              <TocIcon />
            </IconButton>
          </PopoverTarget>
          <PopoverContent data-testid="outline-viewer-panel">
            <Stack gap="xs" miw={200} maw={280}>
              <Group justify="space-between" wrap="nowrap">
                <MyoxusText typographySlot="body-small">{title}</MyoxusText>
                {openOutlinePanel ? (
                  <IconButton
                    aria-label={openSidebarLabel}
                    tooltip={openSidebarLabel}
                    data-testid="toggle-outline-panel-button"
                    onClick={() => {
                      setOpened(false);
                      setPinned(false);
                      openOutlinePanel();
                    }}
                  >
                    <TocIcon />
                  </IconButton>
                ) : null}
              </Group>
              <Scrollable.Viewport autosize maxHeight="popover">
                <TableOfContents
                  size="sm"
                  radius="sm"
                  minDepthToOffset={1}
                  depthOffset={12}
                  reinitializeRef={reinitializeRef}
                  initialData={initialData}
                  scrollSpyOptions={{
                    selector,
                    getDepth: (element) => {
                      const id = resolveBlockId(element);
                      return (id ? (entryById.get(id)?.level ?? 0) : 0) + 1;
                    },
                    getValue: (element) => {
                      const id = resolveBlockId(element);
                      return (
                        (id ? entryById.get(id)?.label : undefined) ??
                        element.textContent ??
                        ""
                      );
                    },
                  }}
                  getControlProps={({ data, active }) => {
                    const node =
                      typeof data.getNode === "function"
                        ? data.getNode()
                        : null;
                    const blockId = resolveBlockId(node) ?? data.id;
                    return {
                      children: data.value,
                      title: data.value,
                      "data-outline-id": blockId,
                      "data-active": active || undefined,
                      onClick: () => navigate(blockId),
                    };
                  }}
                />
              </Scrollable.Viewport>
            </Stack>
          </PopoverContent>
        </Popover>
      </Box>
    </EditorOutlineFloatingFrame>
  );
};
