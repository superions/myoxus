// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { computed, effect, signal, untracked } from "@preact/signals-core";
import {
  NativeBlockProjection,
  NativeGfxBlockComponent,
} from "@virgultum/canvas-runtime/surface";
import { type NoteBlockModel, NoteDisplayMode } from "@virgultum/core/models";
import { SurfaceSelection } from "@virgultum/core/runtime";
import {
  requestThrottledConnectedFrame,
  stopPropagation,
} from "@virgultum/core/utils";

import { createMoreIndicator } from "./components/more-indicator";
import type { EdgelessNoteMask } from "./components/native-note-mask";
import type {
  EdgelessNoteBackground,
  EdgelessPageBlockTitle,
} from "./components/native-note-chrome";
import { noteBlockCss, noteDefinitionsInOrder } from "./note-block";
import {
  EdgelessNoteController,
  MYOXUS_EDGELESS_NOTE,
} from "./note-edgeless-block";
import * as styles from "./note-edgeless-block.styles";

const styledRoots = new WeakSet<Node>();

export class EdgelessNoteBlockComponent extends NativeGfxBlockComponent<NoteBlockModel> {
  readonly noteContent = this.ownerDocument.createElement("div");
  private readonly container = this.ownerDocument.createElement("div");
  private readonly clip = this.ownerDocument.createElement("div");
  private readonly body = this.ownerDocument.createElement("div");
  private readonly childrenContainer = this.ownerDocument.createElement("div");
  private readonly background = this.ownerDocument.createElement(
    "edgeless-note-background",
  ) as EdgelessNoteBackground;
  private readonly noteTitle = this.ownerDocument.createElement(
    "edgeless-page-block-title",
  ) as EdgelessPageBlockTitle;
  private readonly mask = this.ownerDocument.createElement(
    "edgeless-note-mask",
  ) as EdgelessNoteMask;
  private readonly collapseButton = this.ownerDocument.createElement("div");
  private readonly overflow = this.ownerDocument.createElement("div");
  private readonly maskDisabled = signal(false);
  private readonly controller = new EdgelessNoteController(this);
  private projection?: NativeBlockProjection;

  override readonly selected$ = computed(
    () =>
      this.std?.selection.value.some(
        (selection) =>
          selection.blockId === this.blockId && selection.is(SurfaceSelection),
      ) ?? false,
  );

  get hideMask() {
    return this.maskDisabled.value;
  }
  set hideMask(value: boolean) {
    this.maskDisabled.value = value;
  }

  connectedCallback() {
    if (!this.connectBlock()) return;
    this.projection = new NativeBlockProjection(this.host);
    const root = this.getRootNode();
    const styleRoot =
      root instanceof ShadowRoot ? root : this.ownerDocument.head;
    if (!styledRoots.has(styleRoot)) {
      const style = this.ownerDocument.createElement("style");
      style.textContent = noteBlockCss;
      styleRoot.append(style);
      styledRoots.add(styleRoot);
    }
    this.container.className = styles.edgelessNoteContainer;
    this.container.dataset.testid = "edgeless-note-container";
    this.clip.className = styles.clipContainer;
    this.clip.dataset.testid = "edgeless-note-clip-container";
    this.body.className = "edgeless-note-page-content";
    this.childrenContainer.className = "myoxus-block-children-container";
    const note = this.ownerDocument.createElement("div");
    note.className = "myoxus-note-block-container";
    note.append(this.childrenContainer);
    this.body.replaceChildren(note);
    this.background.note = this.noteTitle.note = this.model;
    this.background.std = this.noteTitle.std = this.std;
    this.noteContent.replaceChildren(this.noteTitle, this.body);
    this.clip.replaceChildren(this.noteContent);
    this.container.replaceChildren(this.background, this.clip, this.mask);
    this.collapseButton.className = styles.collapseButton;
    this.collapseButton.dataset.testid = "edgeless-note-collapse-button";
    this.collapseButton.replaceChildren(
      createMoreIndicator(this.ownerDocument),
    );
    this.overflow.className = styles.collapsedContent;

    this.disposables.addFromEvent(
      this.container,
      "mouseleave",
      this.controller.leaved,
    );
    this.disposables.addFromEvent(
      this.container,
      "mousemove",
      this.controller.hovered,
    );
    this.disposables.addFromEvent(
      this.collapseButton,
      "mousedown",
      stopPropagation,
    );
    this.disposables.addFromEvent(
      this.collapseButton,
      "mouseup",
      stopPropagation,
    );
    this.disposables.addFromEvent(
      this.collapseButton,
      "click",
      this.controller.setCollapse,
    );
    this.controller.connect();
    this.controller.mount();
    const refreshContent = requestThrottledConnectedFrame(
      () => this.syncNoteChildren(),
      this,
    );
    this.disposables.add(
      this.store.slots.blockUpdated.subscribe(refreshContent),
    );
    this.disposables.add(
      effect(() => {
        void this.model.children;
        untracked(() => this.syncNoteChildren());
      }),
    );
    this.bindGfx();

    this.disposables.add(
      effect(() => {
        const { selection } = this.gfx;
        if (this.selected$.value && selection.editing)
          untracked(() => this.controller.onEditing());
      }),
    );
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.controller.dispose();
    this.projection?.dispose();
    this.projection = undefined;
    this.replaceChildren();
  }

  override getRenderingRect() {
    return this.controller.getRenderingRect();
  }

  override onBoxSelected() {
    return this.model.props.displayMode !== NoteDisplayMode.DocOnly;
  }

  private syncNoteChildren() {
    const ordinary = this.model.children.filter(
      (child) => child.flavour !== "myoxus:footnote-definition",
    );
    this.projection?.sync(
      [...ordinary, ...noteDefinitionsInOrder(this.model)],
      this.childrenContainer,
    );
  }

  protected override renderGfxView() {
    const state = this.controller.read();
    if (!state) {
      this.container.remove();
      return;
    }

    Object.assign(this.container.style, state.style);
    this.container.dataset.modelHeight = String(state.modelHeight);
    this.container.dataset.editing = String(state.editing);
    this.container.dataset.collapse = String(state.collapse);
    this.container.dataset.scale = String(state.scale);
    if (state.fitsPageTables) this.container.dataset.fitPageTables = "";
    else delete this.container.dataset.fitPageTables;
    this.clip.style.overflowY = state.overflowY;
    this.body.contentEditable = String(!this.store.readonly$.value);
    this.background.editing = state.editing;
    this.mask.state = {
      model: this.model,
      host: this.host,
      radius:
        this.model.props.edgeless.style.borderRadius *
        (this.gfx.viewport.zoom ?? 1),
      disabled: this.hideMask || this.store.readonly,
      editing: state.editing,
    };

    if (state.canToggleCollapse) {
      this.collapseButton.classList.toggle("flip", state.collapseArrowUp);
      this.collapseButton.style.bottom = state.collapseButtonBottom;
      if (this.collapseButton.parentElement !== this.container)
        this.container.insertBefore(
          this.collapseButton,
          this.overflow.parentElement === this.container ? this.overflow : null,
        );
    } else this.collapseButton.remove();
    if (state.collapsedStyle) {
      Object.assign(this.overflow.style, state.collapsedStyle);
      if (this.overflow.parentElement !== this.container)
        this.container.append(this.overflow);
    } else this.overflow.remove();

    if (this.container.parentElement !== this) this.append(this.container);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    [MYOXUS_EDGELESS_NOTE]: EdgelessNoteBlockComponent;
  }
}
