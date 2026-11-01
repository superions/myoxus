import { DocService } from "@myoxus/core/modules/doc";
import { EditorService } from "@myoxus/core/modules/editor";
import { useInsidePeekView } from "@myoxus/core/modules/peek-view/view/modal-container";
import { extractEmojiIcon } from "@myoxus/core/utils";
import { useI18n } from "@myoxus/i18n";
import {
  ExpandFullIcon,
  ToggleDownIcon,
  ToggleRightIcon,
} from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import { track } from "@myoxus/track";
import {
  CanvasOverlayTitleSlot,
  CanvasOverlayTitleText,
  CanvasOverlayToolbar,
  IconButton,
  InlineEdit,
} from "@myoxus/ui-facade";
import { Bound } from "@virgultum/editor/global/gfx";
import {
  type NoteBlockModel,
  type MermaidBlockModel,
} from "@virgultum/editor/model";
import {
  mermaidMessages,
  resolveMermaidEffectiveBlockTitle,
  type MermaidBlockComponent,
} from "@virgultum/block-mermaid";
import type { BlockStdScope } from "@virgultum/std";
import { GfxControllerIdentifier } from "@virgultum/editor/std/gfx";
import { useCallback, useEffect, useMemo, useState } from "react";

import { CopyLinkButton, DocInfoButton } from "./common";
import { EDGELESS_BLOCK_HEADER_COLLAPSED_HEIGHT } from "./geometry";

const EdgelessNoteToggleButton = ({
  note,
  std,
}: {
  note: NoteBlockModel;
  std: BlockStdScope;
}) => {
  const t = useI18n();
  const [collapsed, setCollapsed] = useState(note.props.edgeless.collapse);
  const editor = useService(EditorService).editor;
  const editorContainer = useLiveData(editor.editorContainer$);
  const gfx = editorContainer?.std.get(GfxControllerIdentifier);
  const { doc } = useService(DocService);

  const title = useLiveData(doc.title$);
  const resolveMermaid = useCallback(
    () =>
      note.children.length === 1 &&
      note.children[0]?.flavour === "myoxus:mermaid"
        ? (note.children[0] as MermaidBlockModel)
        : undefined,
    [note],
  );
  const [mermaid, setMermaid] = useState(resolveMermaid);
  const [mermaidTitle, setMermaidTitle] = useState(
    mermaid ? resolveMermaidEffectiveBlockTitle(mermaid.props) : "",
  );
  useEffect(() => {
    // The standard header's portal is reused when selecting another Note.
    // Refresh the child on that transition before subscribing to later edits.
    setMermaid(resolveMermaid());
    const subscription = note.store.slots.blockUpdated.subscribe(() =>
      setMermaid(resolveMermaid()),
    );
    return () => subscription.unsubscribe();
  }, [note, resolveMermaid]);
  useEffect(() => {
    if (!mermaid) return;
    const update = () =>
      setMermaidTitle(resolveMermaidEffectiveBlockTitle(mermaid.props));
    const source = mermaid.props.source.yText;
    const title = mermaid.props.title.yText;
    source.observe(update);
    title.observe(update);
    const subscription = mermaid.propsUpdated.subscribe(update);
    update();
    return () => {
      source.unobserve(update);
      title.unobserve(update);
      subscription.unsubscribe();
    };
  }, [mermaid]);
  // only render emoji if it exists (mode or journal icon will not be rendered)
  const { emoji, rest: titleWithoutEmoji } = useMemo(
    () => extractEmojiIcon(title),
    [title],
  );

  useEffect(() => {
    return note.props.edgeless$.subscribe(({ collapse, collapsedHeight }) => {
      if (
        collapse &&
        collapsedHeight &&
        Math.abs(collapsedHeight - EDGELESS_BLOCK_HEADER_COLLAPSED_HEIGHT) < 1
      ) {
        setCollapsed(true);
      } else {
        setCollapsed(false);
      }
    });
  }, [note.props.edgeless$]);

  useEffect(() => {
    if (!gfx) return;

    const { selection } = gfx;

    const dispose = selection.slots.updated.subscribe(() => {
      if (
        !note.store.readonly &&
        note.props.edgeless.collapse &&
        selection.has(note.id) &&
        selection.editing
      ) {
        note.store.transact(() => {
          note.props.edgeless.collapse = false;
        });
      }
    });

    return () => dispose.unsubscribe();
  }, [gfx, note]);

  const toggle = useCallback(() => {
    if (note.store.readonly) return;
    track.edgeless.pageBlock.headerToolbar.toggle({
      type: collapsed ? "expand" : "collapse",
    });
    note.store.transact(() => {
      if (collapsed) {
        note.props.edgeless.collapse = false;
      } else {
        const bound = Bound.deserialize(note.props.xywh);
        bound.h =
          EDGELESS_BLOCK_HEADER_COLLAPSED_HEIGHT *
          (note.props.edgeless.scale ?? 1);
        note.props.xywh = bound.serialize();
        note.props.edgeless.collapse = true;
        note.props.edgeless.collapsedHeight =
          EDGELESS_BLOCK_HEADER_COLLAPSED_HEIGHT;
        gfx?.selection.clear();
      }
    });
  }, [collapsed, gfx, note]);

  return (
    <>
      <IconButton
        tooltip={t["com.myoxus.editor.edgeless-note-header.fold-page-block"]()}
        data-testid="edgeless-note-toggle-button"
        disabled={note.store.readonly}
        onClick={toggle}
      >
        {collapsed ? <ToggleRightIcon /> : <ToggleDownIcon />}
      </IconButton>
      <CanvasOverlayTitleSlot data-testid="edgeless-note-title">
        {mermaid ? (
          <InlineEdit
            editable={!note.store.readonly}
            value={mermaidTitle}
            placeholder={mermaidMessages.titlePlaceholder()}
            inputAttrs={{ "aria-label": mermaidMessages.titlePlaceholder() }}
            onChange={(value) => {
              const view = std.view.getBlock(
                mermaid.id,
              ) as MermaidBlockComponent | null;
              view?.editDiagramTitle(value);
            }}
          />
        ) : (
          collapsed && (
            <>
              {emoji && <span>{emoji}</span>}
              <CanvasOverlayTitleText emphasis="strong">
                {titleWithoutEmoji}
              </CanvasOverlayTitleText>
            </>
          )
        )}
      </CanvasOverlayTitleSlot>
    </>
  );
};

const OpenInPageButton = () => {
  const t = useI18n();
  const editor = useService(EditorService).editor;

  const openInPage = useCallback(() => {
    track.edgeless.pageBlock.headerToolbar.switchPageMode();
    editor.setMode("page");
  }, [editor]);

  return (
    <IconButton
      tooltip={t["com.myoxus.editor.edgeless-note-header.open-in-page"]()}
      data-testid="edgeless-note-view-in-page-button"
      onClick={openInPage}
    >
      <ExpandFullIcon />
    </IconButton>
  );
};

const PageBlockInfoButton = ({ note }: { note: NoteBlockModel }) => {
  const trackFn = useCallback(() => {
    track.edgeless.pageBlock.headerToolbar.openDocInfo();
  }, []);

  return (
    <DocInfoButton
      docId={note.store.id}
      trackFn={trackFn}
      data-testid="edgeless-note-info-button"
    />
  );
};

const NoteCopyLinkButton = ({ note }: { note: NoteBlockModel }) => {
  const trackFn = useCallback(() => {
    track.edgeless.pageBlock.headerToolbar.copyBlockToLink();
  }, []);

  return (
    <CopyLinkButton
      pageId={note.store.id}
      blockId={note.id}
      mode="edgeless"
      trackFn={trackFn}
      data-testid="edgeless-note-link-button"
    />
  );
};

export const EdgelessNoteHeader = ({
  note,
  std,
}: {
  note: NoteBlockModel;
  std: BlockStdScope;
}) => {
  const insidePeekView = useInsidePeekView();

  return (
    <CanvasOverlayToolbar data-testid="edgeless-page-block-header">
      <EdgelessNoteToggleButton note={note} std={std} />
      <OpenInPageButton />
      {!insidePeekView && <PageBlockInfoButton note={note} />}
      <NoteCopyLinkButton note={note} />
    </CanvasOverlayToolbar>
  );
};
