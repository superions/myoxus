// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { computed, signal, type ReadonlySignal } from "@preact/signals-core";
import { changeNoteDisplayMode } from "@virgultum/block-note";
import { Bound } from "@virgultum/global/gfx";
import {
  AttachmentBlockModel,
  BookmarkBlockModel,
  CodeBlockModel,
  ImageBlockModel,
  ListBlockModel,
  NoteBlockModel,
  NoteDisplayMode,
  ParagraphBlockModel,
  RootBlockModel,
} from "@virgultum/model";
import {
  DocDisplayMetaProvider,
  DocEmbedProvider,
  DocModeProvider,
  EditorI18nProvider,
  editorMessage,
  resolveEditorMessage,
  type EditorOutlineControls,
  type EditorOutlineEntry,
  type EditorOutlineState,
} from "@virgultum/shared/services";
import { focusTitle, matchModels } from "@virgultum/shared/utils";
import type { MyoxusTextAttributes } from "@virgultum/shared/types";
import {
  BlockSelection,
  type BlockStdScope,
  type EditorHost,
} from "@virgultum/std";
import { GfxControllerIdentifier } from "@virgultum/std/gfx";
import type { BlockModel } from "@virgultum/store";
import {
  defaultOutlinePanelLabels,
  outlineSettingsKey,
  type OutlinePanelLabels,
} from "./config";
import {
  getHeadingBlocksFromDoc,
  getNotesFromStore,
  isHeadingBlock,
} from "./utils/query";
import {
  observeActiveHeadingDuringScroll,
  scrollToBlockWithHighlight,
} from "./utils/scroll";
import type { NoteCardEntity, NoteDropPayload } from "./utils/drag";

/** Project authored previews without mounting a second editor or loading document bodies. */
export function describeOutlineBlock(
  block: BlockModel,
  std: BlockStdScope,
  titles = new Map<string, ReadonlySignal<string>>(),
): EditorOutlineEntry | undefined {
  const message = (key: string, fallback: string) =>
    resolveEditorMessage(
      editorMessage(key, fallback),
      std.getOptional(EditorI18nProvider) ?? undefined,
    );
  if (matchModels(block, [RootBlockModel])) {
    const label = block.props.title$.value.deltas$.value
      .map((delta) => String(delta.insert))
      .join("");
    return label
      ? { id: block.id, label, level: 0, icon: "PageIcon" }
      : undefined;
  }
  if (matchModels(block, [ParagraphBlockModel, ListBlockModel])) {
    const type = block.props.type$.value;
    const icons = {
      text: "TextIcon",
      quote: "QuoteIcon",
      h1: "Heading1Icon",
      h2: "Heading2Icon",
      h3: "Heading3Icon",
      h4: "Heading4Icon",
      h5: "Heading5Icon",
      h6: "Heading6Icon",
      bulleted: "BulletedListIcon",
      numbered: "NumberedListIcon",
      todo: "CheckBoxCheckLinearIcon",
      toggle: "BlockIcon",
    } as const;
    const segments = block.props.text$.value.deltas$.value.flatMap((delta) => {
      const reference = (delta.attributes as MyoxusTextAttributes | undefined)
        ?.reference;
      if (!reference) return [{ text: String(delta.insert) }];
      const meta = std.workspace.meta.docMetas.find(
        (doc) => doc.id === reference.pageId,
      );
      if (
        !meta ||
        std.getOptional(DocEmbedProvider)?.readable(meta.id).value !== true ||
        (reference.workspaceId && reference.workspaceId !== std.workspace.id)
      )
        return [
          {
            text: message(
              "com.myoxus.reference.target-unavailable",
              "Target unavailable",
            ),
            unavailable: true,
          },
        ];
      let title = titles.get(meta.id);
      if (!title) {
        title = std.get(DocDisplayMetaProvider).title(meta.id);
        titles.set(meta.id, title);
      }
      return [
        {
          text: title.value || message("Untitled", "Untitled"),
          docId: meta.id,
        },
      ];
    });
    const label = segments.map((segment) => segment.text).join("");
    return label.trim()
      ? {
          id: block.id,
          label,
          segments,
          level: /^h[1-6]$/.test(type) ? Number(type[1]) - 1 : 0,
          icon: icons[type],
        }
      : undefined;
  }
  let label: string, icon: EditorOutlineEntry["icon"];
  if (matchModels(block, [BookmarkBlockModel])) {
    label =
      block.props.title$.value ||
      block.props.url$.value ||
      message("Bookmark", "Bookmark");
    icon = "BookmarkIcon";
  } else if (matchModels(block, [CodeBlockModel])) {
    label =
      block.props.language$.value ||
      message("com.myoxus.editor.slash.code-block", "Code Block");
    icon = "CodeBlockIcon";
  } else if (matchModels(block, [ImageBlockModel])) {
    label = block.props.caption$.value || message("Image", "Image");
    icon = "ImageIcon";
  } else if (matchModels(block, [AttachmentBlockModel])) {
    label =
      block.props.name$.value ||
      message("com.myoxus.editor.slash.attachment", "Attachment");
    icon = "AttachmentIcon";
  } else return;
  return { id: block.id, label, level: 0, icon };
}

/** One lazy, subscription-owned scope serves the sidebar and standalone editor mounts. */
export class DocumentOutlineController implements EditorOutlineControls {
  private readonly active = signal<string | null>(null);
  private readonly center = signal<number | null>(null);
  private readonly revision = signal(0);
  private readonly selected = signal<ReadonlySet<string>>(new Set());
  private readonly icons = signal(false);
  private readonly sorting = signal(false);
  private readonly canvasSorting = signal(true);
  private readonly dismissed = signal(false);
  private readonly drop = signal<EditorOutlineState["drop"]>(undefined);
  private readonly titles = new Map<string, ReadonlySignal<string>>();
  private readonly snapshot: ReadonlySignal<EditorOutlineState>;
  private subscribers = 0;
  private cleanups: (() => void)[] = [];
  private stopScroll?: () => void;
  private clearHighlight = () => {};
  private navigation = 0;
  private locked = false;

  constructor(
    readonly editor: EditorHost,
    readonly options: {
      labels?: OutlinePanelLabels;
      compactWindowRadius?: number;
      hideHeader?: boolean;
      fitPadding?: number[];
    } = {},
  ) {
    // Read settings only. Subscription, pointer and scroll work begin after React commits.
    const stored = localStorage.getItem(outlineSettingsKey);
    if (stored) {
      try {
        const settings = JSON.parse(stored);
        this.icons.value = settings.showIcons === true;
        this.sorting.value = settings.enableSorting === true;
      } catch {
        /* Invalid personal preferences keep defaults without changing document state. */
      }
    }
    this.snapshot = computed(() => this.project());
  }
  private get std() {
    return this.editor.std;
  }
  private get store() {
    return this.editor.store;
  }
  private get edgeless() {
    return this.std.get(DocModeProvider).getEditorMode() === "edgeless";
  }
  private get notes() {
    return getNotesFromStore(this.store);
  }
  private selectedIds() {
    return this.edgeless
      ? new Set(
          [
            ...this.std.get(GfxControllerIdentifier).selection.selectedIds,
            ...this.selected.value,
          ].filter((id) => this.notes.some((note) => note.id === id)),
        )
      : this.selected.value;
  }
  private project(): EditorOutlineState {
    void this.revision.value;
    // Compact sidebars navigate the authored hierarchy; full-panel preferences
    // must never turn the table of contents into a document-reordering tool.
    const radius = this.options.compactWindowRadius ?? 0;
    const compact = radius > 0;
    const sorting =
      !compact &&
      (this.edgeless ? this.canvasSorting.value : this.sorting.value);
    const headings = getHeadingBlocksFromDoc(
      this.store,
      [NoteDisplayMode.DocAndEdgeless, NoteDisplayMode.DocOnly],
      true,
    );
    const activeIndex = Math.max(
      0,
      headings.findIndex((block) => block.id === this.active.value),
    );
    const center = Math.min(
      Math.max(this.center.value ?? activeIndex, 0),
      Math.max(0, headings.length - 1),
    );
    const start = compact ? Math.max(0, center - radius) : 0;
    const end = compact
      ? Math.min(headings.length, center + radius + 1)
      : headings.length;
    const selected = this.selectedIds();
    const entries = headings
      .slice(start, end)
      .flatMap(
        (block) => describeOutlineBlock(block, this.std, this.titles) ?? [],
      );
    const notes = !compact
      ? this.notes
          .filter(
            (note) =>
              sorting ||
              note.children.some(
                (block) => isHeadingBlock(block) && block.text?.length,
              ),
          )
          .toSorted(
            (a, b) =>
              Number(
                a.props.displayMode$.value === NoteDisplayMode.EdgelessOnly,
              ) -
              Number(
                b.props.displayMode$.value === NoteDisplayMode.EdgelessOnly,
              ),
          )
          .map((note, index) => ({
            id: note.id,
            index,
            mode: note.props.displayMode$.value,
            selected: selected.has(note.id),
            entries: note.children
              .filter((block) => sorting || isHeadingBlock(block))
              .flatMap(
                (block) =>
                  describeOutlineBlock(block, this.std, this.titles) ?? [],
              ),
          }))
      : [];
    return {
      labels: this.options.labels ?? defaultOutlinePanelLabels,
      hideHeader: this.options.hideHeader ?? false,
      activeId: this.active.value,
      showIcons: this.icons.value,
      sorting,
      edgeless: this.edgeless,
      readonly: this.store.readonly,
      notice:
        !compact &&
        !sorting &&
        !this.dismissed.value &&
        this.notes.some(
          (note) => note.props.displayMode$.value === NoteDisplayMode.DocOnly,
        ),
      entries,
      title:
        !compact && headings.length && this.store.root
          ? describeOutlineBlock(this.store.root, this.std, this.titles)
          : undefined,
      notes,
      previous: compact && start > 0 ? center - 1 : undefined,
      next: compact && end < headings.length ? center + 1 : undefined,
      drop: this.drop.value,
    };
  }
  getSnapshot = () => this.snapshot.value;
  subscribe = (listener: () => void) => {
    if (this.subscribers++ === 0) this.attach();
    const stop = this.snapshot.subscribe(listener);
    return () => {
      stop();
      if (--this.subscribers === 0) {
        this.cleanups.splice(0).forEach((cleanup) => cleanup());
        this.bindScroll(null);
        this.clearHighlight();
        this.navigation++;
        this.locked = false;
      }
    };
  };
  private attach() {
    const blocks = this.store.slots.blockUpdated.subscribe(
      () => this.revision.value++,
    );
    const selection = this.std
      .getOptional(GfxControllerIdentifier)
      ?.selection.slots.updated.subscribe(() => this.revision.value++);
    const scroll = observeActiveHeadingDuringScroll(
      () => this.editor,
      (id) => {
        if (this.locked) return;
        if (this.active.value !== id) this.center.value = null;
        this.active.value = id;
      },
    );
    const monitor = this.std.dnd.monitor<NoteCardEntity, NoteDropPayload>({
      canMonitor: ({ source }) =>
        source.data.bsEntity?.type === "toc-card" &&
        source.data.from?.docId === this.store.id,
      onDrag: (data) => {
        const target = data.location.current.dropTargets[0];
        const edge = target?.data.edge;
        this.drop.value =
          target && (edge === "top" || edge === "bottom")
            ? { id: target.data.noteId, edge }
            : undefined;
      },
      onDrop: (data) => {
        const target = data.location.current.dropTargets[0];
        const edge = target?.data.edge;
        this.drop.value = undefined;
        if (target && (edge === "top" || edge === "bottom"))
          this.reorder(target.data.noteId, edge);
      },
    });
    this.cleanups = [
      () => blocks.unsubscribe(),
      () => selection?.unsubscribe(),
      () => scroll.dispose(),
      monitor,
    ];
  }
  private save() {
    if (this.edgeless) return;
    localStorage.setItem(
      outlineSettingsKey,
      JSON.stringify({
        showIcons: this.icons.value,
        enableSorting: this.sorting.value,
      }),
    );
  }
  toggleIcons = () => {
    this.icons.value = !this.icons.value;
    this.save();
  };
  toggleSorting = () => {
    if (this.options.compactWindowRadius) return;
    if (this.edgeless) this.canvasSorting.value = !this.canvasSorting.value;
    else {
      this.sorting.value = !this.sorting.value;
      this.save();
    }
  };
  dismissNotice = () => {
    this.dismissed.value = true;
  };
  window = (index: number) => {
    this.center.value = index;
  };
  navigate = (id: string) => {
    const block = this.store.getBlock(id)?.model;
    if (!block) return;
    if (this.edgeless) {
      const note = matchModels(block, [NoteBlockModel])
        ? block
        : this.store.getParent(block);
      if (note && matchModels(note, [NoteBlockModel]))
        this.select(note.id, false);
      return;
    }
    const navigation = ++this.navigation;
    this.locked = true;
    this.active.value = id;
    this.center.value = null;
    if (id === this.store.root?.id) {
      this.std.selection.setGroup("note", []);
      this.std.event.active = false;
      focusTitle(this.editor);
    } else {
      this.std.event.active = true;
      this.std.selection.setGroup("note", [
        this.std.selection.create(BlockSelection, { blockId: id }),
      ]);
    }
    this.clearHighlight();
    scrollToBlockWithHighlight(this.editor, id)
      .then((clear) => {
        if (navigation !== this.navigation || !this.subscribers) return clear();
        this.clearHighlight = clear;
        this.locked = false;
      })
      .catch((error) => {
        if (navigation === this.navigation) this.locked = false;
        console.error(error);
      });
  };
  fit = (id: string) => {
    const note = this.store.getBlock(id)?.model;
    if (!note || !matchModels(note, [NoteBlockModel]) || !this.edgeless) return;
    const padding = this.options.fitPadding;
    this.std
      .get(GfxControllerIdentifier)
      .viewport.setViewportByBound(
        Bound.deserialize(note.props.xywh$.value),
        padding?.length === 4
          ? (padding.map((n) => (Number.isFinite(n) ? n : 0)) as [
              number,
              number,
              number,
              number,
            ])
          : [0, 0, 0, 0],
        true,
      );
  };
  select = (id: string, multiple: boolean) => {
    const note = this.store.getBlock(id)?.model;
    if (!note || !matchModels(note, [NoteBlockModel])) return;
    const current = this.selectedIds();
    const ids = multiple ? new Set(current) : new Set<string>();
    if (current.has(id) && (multiple || current.size === 1)) ids.delete(id);
    else ids.add(id);
    this.setSelection(ids);
  };
  private setSelection(ids: ReadonlySet<string>) {
    if (this.edgeless) {
      this.selected.value = new Set(
        [...ids].filter((id) =>
          this.notes.some(
            (note) =>
              note.id === id &&
              note.props.displayMode === NoteDisplayMode.DocOnly,
          ),
        ),
      );
      this.std.get(GfxControllerIdentifier).selection.set({
        elements: [...ids].filter((key) =>
          this.notes.some(
            (note) =>
              note.id === key &&
              note.props.displayMode !== NoteDisplayMode.DocOnly,
          ),
        ),
        editing: false,
      });
    } else this.selected.value = ids;
  }
  changeMode = (id: string, mode: NoteDisplayMode) => {
    if (
      this.options.compactWindowRadius ||
      this.store.readonly ||
      !this.store.getBlock(id)
    )
      return;
    this.std.command.exec(changeNoteDisplayMode, {
      noteId: id,
      mode,
      stopCapture: true,
    });
    this.store.captureSync();
    if (this.edgeless && mode === NoteDisplayMode.DocOnly) {
      const selection = this.std.get(GfxControllerIdentifier).selection;
      selection.set({
        elements: selection.selectedIds.filter((key) => key !== id),
        editing: false,
      });
    }
  };
  private reorder(targetId: string, edge: "top" | "bottom") {
    const root = this.store.root;
    if (!root || this.store.readonly || !this.getSnapshot().sorting) return;
    const selected = this.selectedIds();
    if (!selected.size || selected.has(targetId)) return;
    const target = root.children.find((block) => block.id === targetId);
    if (
      !target ||
      !matchModels(target, [NoteBlockModel]) ||
      target.props.displayMode === NoteDisplayMode.EdgelessOnly
    )
      return;
    const moving = root.children.filter(
      (block) =>
        selected.has(block.id) &&
        matchModels(block, [NoteBlockModel]) &&
        block.props.displayMode !== NoteDisplayMode.EdgelessOnly,
    );
    const children = root.children.filter((block) => !moving.includes(block));
    const index = children.indexOf(target) + (edge === "bottom" ? 1 : 0);
    children.splice(index, 0, ...moving);
    if (children.every((block, i) => block === root.children[i])) return;
    this.store.captureSync();
    this.store.updateBlock(root, { children });
    this.store.captureSync();
  }
  history = (redo: boolean) => {
    if (!this.store.readonly) {
      if (redo) this.store.redo();
      else this.store.undo();
    }
  };
  bindScroll = (element: HTMLDivElement | null) => {
    this.stopScroll?.();
    this.stopScroll = undefined;
    if (!element) return;
    this.stopScroll = this.std.dnd.autoScroll<NoteCardEntity>({
      element,
      canScroll: ({ source }) =>
        source.data.bsEntity?.type === "toc-card" &&
        source.data.from?.docId === this.store.id,
    });
  };
  bindNote = (element: HTMLElement, id: string) => {
    const enabled = () =>
      !this.store.readonly &&
      this.getSnapshot().sorting &&
      this.notes.some(
        (note) =>
          note.id === id &&
          note.props.displayMode !== NoteDisplayMode.EdgelessOnly,
      );
    const drag = this.std.dnd.draggable<NoteCardEntity>({
      element,
      canDrag: enabled,
      onDragStart: () => {
        if (!this.selectedIds().has(id)) this.select(id, false);
      },
      setDragData: () => ({ type: "toc-card", noteId: id }),
      setDragPreview: ({ container, setOffset, location }) => {
        const rect = element.getBoundingClientRect();
        setOffset({
          x: location.current.input.clientX - rect.left,
          y: location.current.input.clientY - rect.top,
        });
        // Drag preview geometry mirrors the measured native row; it owns no alternate chrome.
        container.style.width = `${rect.width}px`;
        container.append(element.cloneNode(true));
      },
    });
    const drop = this.std.dnd.dropTarget<NoteCardEntity, NoteDropPayload>({
      element,
      allowDropPosition: ["top", "bottom"],
      canDrop: ({ source }) =>
        enabled() &&
        source.data.bsEntity?.type === "toc-card" &&
        source.data.from?.docId === this.store.id,
      setDropData: () => ({ noteId: id }),
    });
    return () => {
      drag();
      drop();
    };
  };
}
