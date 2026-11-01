import {
  editorMessage,
  EditorI18nProvider,
  resolveEditorMessage,
  type EditorI18nMessage,
} from "@virgultum/shared/services";
import { consume, ContextProvider } from "@lit/context";
import { ArrowDownSmallIcon, InvisibleIcon } from "@myoxus/icons/lit";
import { cssVar } from "@myoxus/theme";
import { signal } from "@preact/signals-core";
import { SignalWatcher, WithDisposable } from "@virgultum/global/lit";
import { type NoteBlockModel, NoteDisplayMode } from "@virgultum/model";
import { createButtonPopper } from "@virgultum/shared/utils";
import { ShadowlessElement } from "@virgultum/std";
import type { BlockModel } from "@virgultum/store";
import { html } from "lit";
import { property, query } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";

import { type TocContext, tocContext } from "../config";
import type { SelectEvent } from "../utils/custom-events";
import type { NoteCardEntity, NoteDropPayload } from "../utils/drag";
import * as styles from "./outline-card.styles";

export const MYOXUS_OUTLINE_NOTE_CARD = "myoxus-outline-note-card";

export class OutlineNoteCard extends SignalWatcher(
  WithDisposable(ShadowlessElement),
) {
  private _text(message: EditorI18nMessage) {
    return resolveEditorMessage(
      message,
      this._context.editor$.value.std.getOptional(EditorI18nProvider) ??
        undefined,
    );
  }

  private _displayModePopper: ReturnType<typeof createButtonPopper> | null =
    null;

  private readonly _showPopper$ = signal(false);

  private _dispatchClickBlockEvent(block: BlockModel) {
    const event = new CustomEvent("clickblock", {
      detail: {
        blockId: block.id,
      },
    });

    this.dispatchEvent(event);
  }

  private _dispatchDisplayModeChangeEvent(newMode: NoteDisplayMode) {
    const event = new CustomEvent("displaymodechange", {
      detail: {
        note: this.note,
        newMode,
      },
    });

    this.dispatchEvent(event);
  }

  private _dispatchFitViewEvent(e: MouseEvent) {
    e.stopPropagation();

    const event = new CustomEvent("fitview", {
      detail: {
        block: this.note,
      },
    });

    this.dispatchEvent(event);
  }

  private _dispatchSelectEvent(e: MouseEvent) {
    e.stopPropagation();
    const event = new CustomEvent("select", {
      detail: {
        id: this.note.id,
        selected: this.status !== "selected",
        multiselect: e.shiftKey,
      },
    }) as SelectEvent;

    this.dispatchEvent(event);
  }

  private _getCurrentModeLabel(mode: NoteDisplayMode) {
    switch (mode) {
      case NoteDisplayMode.DocAndEdgeless:
        return this._context.labels$.value.modeBoth;
      case NoteDisplayMode.EdgelessOnly:
        return this._context.labels$.value.modeEdgeless;
      case NoteDisplayMode.DocOnly:
        return this._context.labels$.value.modePage;
      default:
        return this._context.labels$.value.modeBoth;
    }
  }

  private _watchDragEvents() {
    const std = this._context.editor$.value.std;
    this.disposables.add(
      std.dnd.draggable<NoteCardEntity>({
        element: this,
        canDrag: () =>
          this.note.props.displayMode !== NoteDisplayMode.EdgelessOnly,
        onDragStart: () => {
          if (this.status !== "selected") {
            this.dispatchEvent(
              new CustomEvent("select", {
                detail: {
                  id: this.note.id,
                  selected: true,
                  multiselect: false,
                },
              }),
            );
          }
        },
        setDragData: () => ({
          type: "toc-card",
          noteId: this.note.id,
        }),
        setDragPreview: ({ container, setOffset, location }) => {
          const preview = document.createElement(MYOXUS_OUTLINE_NOTE_CARD);
          preview.note = this.note;
          preview.index = this.index;
          preview._context = this._context;

          const { clientX, clientY } = location.current.input;
          const { left, top } = this.getBoundingClientRect();
          setOffset({ x: clientX - left, y: clientY - top });

          container.style.width = `${this.parentElement?.clientWidth ?? 0}px`;
          container.style.maxHeight = "500px";
          container.style.overflow = "hidden";
          container.style.backgroundColor = cssVar("backgroundPrimaryColor");
          container.append(preview);
          const provider = new ContextProvider(container, {
            context: tocContext,
            initialValue: this._context,
          });
          provider.hostConnected();
        },
      }),
    );

    this.disposables.add(
      std.dnd.dropTarget<NoteCardEntity, NoteDropPayload>({
        element: this,
        setDropData: () => ({
          noteId: this.note.id,
        }),
        canDrop: () => {
          return this.note.props.displayMode !== NoteDisplayMode.EdgelessOnly;
        },
      }),
    );
  }

  override connectedCallback() {
    super.connectedCallback();
    this._watchDragEvents();
  }

  override firstUpdated() {
    this._displayModePopper = createButtonPopper({
      reference: this._displayModeButtonGroup,
      popperElement: this._displayModePanel,
      stateUpdated: ({ display }) => {
        this._showPopper$.value = display === "show";
      },
      mainAxis: 0,
      crossAxis: -60,
    });

    this.disposables.add(this._displayModePopper);
  }

  override render() {
    const { displayMode } = this.note.props;
    const { children } = this.note;
    const currentMode = this._getCurrentModeLabel(displayMode);
    const invisible =
      this.note.props.displayMode$.value === NoteDisplayMode.EdgelessOnly;

    const enableSorting = this._context.enableSorting$.value;

    return html`
      <div
        data-visibility=${this.note.props.displayMode}
        data-sortable=${enableSorting}
        data-status=${this.status}
        class=${styles.outlineCard}
      >
        <div
          class=${styles.cardPreview}
          @click=${this._dispatchSelectEvent}
          @dblclick=${this._dispatchFitViewEvent}
        >
        ${html`<div class=${styles.cardHeader}>
          ${
            invisible
              ? html`<span class=${styles.headerIcon}
                  >${InvisibleIcon({ width: "20px", height: "20px" })}</span
                >`
              : html`<span class=${styles.headerNumber}
                  >${this.index + 1}</span
                >`
          }
          <span class=${styles.divider}></span>
          <div class=${styles.displayModeButtonGroup}>
            <span>${this._text(editorMessage("com.myoxus.editor.note.show-in", "Show in"))}</span>
            <edgeless-tool-icon-button
              .tooltip=${this._showPopper$.value ? "" : this._text(editorMessage("com.myoxus.editor.note.display-mode", "Display mode"))}
              .tipPosition=${"left-start"}
              .iconContainerPadding=${0}
              data-testid="display-mode-button"
              @click=${(e: MouseEvent) => {
                e.stopPropagation();
                this._displayModePopper?.toggle();
              }}
              @dblclick=${(e: MouseEvent) => e.stopPropagation()}
            >
              <div class=${styles.displayModeButton}>
                <span class=${styles.currentModeLabel}>${currentMode}</span>
                ${ArrowDownSmallIcon({ width: "16px", height: "16px" })}
              </div>
            </edgeless-tool-icon-button>
          </div>
          </div>
          <note-display-mode-panel
            class=${styles.modeChangePanel}
            .i18n=${this._context.editor$.value.std.getOptional(EditorI18nProvider) ?? undefined}
            .displayMode=${displayMode}
            .panelWidth=${220}
            .onSelect=${(newMode: NoteDisplayMode) => {
              this._dispatchDisplayModeChangeEvent(newMode);
              this._displayModePopper?.hide();
            }}
          >
          </note-display-mode-panel>
        </div>`}
          <div class=${styles.cardContent}>
            ${children.map((block) => {
              return html`<myoxus-outline-block-preview
                class=${classMap({ active: this.activeHeadingId === block.id })}
                .block=${block}
                .disabledIcon=${invisible}
                @click=${() => {
                  if (invisible) return;
                  this._dispatchClickBlockEvent(block);
                }}
              ></myoxus-outline-block-preview>`;
            })}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  @query(`.${styles.displayModeButtonGroup}`)
  private accessor _displayModeButtonGroup!: HTMLDivElement;

  @query("note-display-mode-panel")
  private accessor _displayModePanel!: HTMLDivElement;

  @property({ attribute: false })
  accessor activeHeadingId: string | null = null;

  @property({ attribute: false })
  accessor note!: NoteBlockModel;

  @property({ attribute: true, type: Number })
  accessor index: number = 0;

  @property({ attribute: false })
  accessor status: "selected" | "dragging" | "normal" = "normal";

  @consume({ context: tocContext })
  private accessor _context!: TocContext;
}

declare global {
  interface HTMLElementTagNameMap {
    [MYOXUS_OUTLINE_NOTE_CARD]: OutlineNoteCard;
  }
}
