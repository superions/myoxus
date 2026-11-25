import { computed } from "@preact/signals-core";
import { Heading1Icon, LinkIcon, TextIcon } from "@myoxus/icons/native";
import {
  EditPropsStore,
  ThemeProvider,
  EditorChromeHostIdentifier,
  EditorI18nProvider,
  editorMessage,
  resolveEditorMessage,
} from "@virgultum/core/services";
import { NativeViewElement } from "@virgultum/core/runtime";
import { EdgelessToolbarToolMixin } from "../../../widgets/edgeless-toolbar/index";

import { NoteTool, type NoteToolOption } from "../note-tool.js";
import { toShapeNotToAdapt } from "./icon.js";

const noteToolbarArtworkStyles = `
  :host,
  .edgeless-note-button {
    display: block;
    width: 100%;
    height: 100%;
  }
  :host * {
    box-sizing: border-box;
  }

  .note-root[data-app-theme="light"] {
    --paper-border-color: var(--myoxus-pure-white);
    --paper-foriegn-color: rgba(0, 0, 0, 0.1);
    --paper-shadow: 0px 2px 4px rgba(0, 0, 0, 0.25);
    --icon-card-bg: #fff;
    --icon-card-shadow:
      0px 2px 4px rgba(0, 0, 0, 0.22), inset 0px -2px 1px rgba(0, 0, 0, 0.14);
  }
  .note-root[data-app-theme="dark"] {
    --paper-border-color: var(--myoxus-divider-color);
    --paper-foriegn-color: rgba(255, 255, 255, 0.12);
    --paper-shadow: 0px 2px 6px rgba(0, 0, 0, 0.8);
    --icon-card-bg: #343434;
    --icon-card-shadow:
      0px 2px 4px rgba(0, 0, 0, 0.6),
      inset 0px -2px 1px rgba(255, 255, 255, 0.06);
  }

  .note-root {
    width: 100%;
    height: 64px;
    background: transparent;
    position: relative;
    overflow: hidden;
    cursor: pointer;
    display: flex;
    align-items: flex-end;
    justify-content: center;
  }
  .paper {
    --y: 20px;
    --r: 4.42deg;
    width: 60px;
    height: 72px;
    background: var(--paper-bg);
    border: 1px solid var(--paper-border-color);
    position: absolute;
    transform: translateY(var(--y)) rotate(var(--r));
    color: var(--paper-foriegn-color);
    box-shadow: var(--paper-shadow);
    padding-top: 32px;
    padding-left: 3px;
    transition: transform 0.4s ease;
  }
  .edgeless-toolbar-note-icon {
    position: absolute;
    width: 26px;
    height: 26px;
    border-radius: 2px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--myoxus-icon-secondary);
    background: var(--icon-card-bg);
    box-shadow: var(--icon-card-shadow);
    bottom: 12px;
    transition: transform 0.4s ease;
    transform: translateX(var(--x)) translateY(var(--y)) rotate(var(--r));
  }
  .edgeless-toolbar-note-icon svg {
    width: 20px;
    height: 20px;
  }
  .edgeless-toolbar-note-icon.link {
    --x: -22px;
    --y: -5px;
    --r: -6deg;
    transform-origin: 0% 100%;
  }
  .edgeless-toolbar-note-icon.text {
    --r: 4deg;
    --x: 0px;
    --y: 0px;
  }
  .edgeless-toolbar-note-icon.heading {
    --x: 21px;
    --y: -7px;
    --r: 8deg;
    transform-origin: 0% 100%;
  }

  .note-root:hover .paper {
    --y: 15px;
  }
  .note-root:hover .link {
    --x: -25px;
    --y: -5px;
    --r: -9.5deg;
  }
  .note-root:hover .text {
    --y: -10px;
  }
  .note-root:hover .heading {
    --x: 23px;
    --y: -8px;
    --r: 15deg;
  }
`;

/** Retained paper artwork is a renderer; native buttons own its interaction chrome. */
export class NoteToolbarArtwork extends NativeViewElement {
  private readonly _rootEl: HTMLDivElement;
  private _color = "";
  private _theme = "";

  constructor() {
    super();
    const shadow = this.attachShadow({ mode: "open" });
    const style = this.ownerDocument.createElement("style");
    style.textContent = noteToolbarArtworkStyles;
    this._rootEl = this.ownerDocument.createElement("div");
    this._rootEl.className = "note-root";

    const paper = this.ownerDocument.createElement("div");
    paper.className = "paper";
    paper.innerHTML = toShapeNotToAdapt;

    const link = this.ownerDocument.createElement("div");
    link.className = "edgeless-toolbar-note-icon link";
    link.innerHTML = LinkIcon;

    const heading = this.ownerDocument.createElement("div");
    heading.className = "edgeless-toolbar-note-icon heading";
    heading.innerHTML = Heading1Icon;

    const text = this.ownerDocument.createElement("div");
    text.className = "edgeless-toolbar-note-icon text";
    text.innerHTML = TextIcon;

    this._rootEl.append(paper, link, heading, text);
    shadow.append(style, this._rootEl);
  }

  get color() {
    return this._color;
  }

  set color(value: string) {
    this._color = value;
    this._rootEl.style.setProperty("--paper-bg", value);
  }

  get theme() {
    return this._theme;
  }

  set theme(value: string) {
    this._theme = value;
    this._rootEl.dataset.appTheme = value;
  }
}

export class EdgelessNoteSeniorButton extends EdgelessToolbarToolMixin(
  NativeViewElement,
) {
  private _childFlavour: NoteToolOption["childFlavour"] = "myoxus:paragraph";
  private _childType = "text";
  private _tip = "Note";
  private _artwork: NoteToolbarArtwork | null = null;

  private readonly _noteBg$ = computed(() => {
    return this.edgeless.std
      .get(ThemeProvider)
      .generateColorProperty(
        this.edgeless.std.get(EditPropsStore).lastProps$.value["myoxus:note"]
          .background,
      );
  });

  private readonly _states = ["childFlavour", "childType", "tip"] as const;

  override enableActiveBackground = false;

  override type = NoteTool;

  get childFlavour() {
    return this._childFlavour;
  }

  set childFlavour(value: NoteToolOption["childFlavour"]) {
    if (this._childFlavour === value) return;
    this._childFlavour = value;
    this.requestUpdate();
  }

  get childType() {
    return this._childType;
  }

  set childType(value: string) {
    if (this._childType === value) return;
    this._childType = value;
    this.requestUpdate();
  }

  get tip() {
    return this._tip;
  }

  set tip(value: string) {
    if (this._tip === value) return;
    this._tip = value;
    this.requestUpdate();
  }

  private _ensureArtwork() {
    if (!this._artwork) {
      this._artwork = this.ownerDocument.createElement(
        "edgeless-note-toolbar-artwork",
      );
      Object.assign(this._artwork.style, {
        width: "96px",
        height: "64px",
      });
    }
    return this._artwork;
  }

  private readonly _mountArtwork = (host: HTMLElement) => {
    const artwork = this._ensureArtwork();
    host.append(artwork);
    return () => {
      artwork.remove();
    };
  };

  private _toggleNoteMenu() {
    if (this.tryDisposePopper()) return;

    const { edgeless, childFlavour, childType, tip } = this;

    this.setEdgelessTool(NoteTool, {
      childFlavour,
      childType,
      tip,
    });
    this.createPopper("edgeless-note-menu", this, {
      setProps: (element) => {
        Object.assign(element, {
          edgeless,
          childFlavour,
          childType,
          tip,
          onChange: (
            props: Partial<{
              childFlavour: NoteToolOption["childFlavour"];
              childType: string | null;
              tip: string;
            }>,
          ) => {
            this._states.forEach((key) => {
              // oxlint-disable-next-line eqeqeq
              if (props[key] != undefined) {
                Object.assign(this, { [key]: props[key] });
              }
            });
            this.setEdgelessTool(NoteTool, {
              childFlavour: this.childFlavour,
              childType: this.childType,
              tip: this.tip,
            });
          },
        });
      },
    });
  }

  protected override paint() {
    const chrome = this.edgeless.std.getOptional(EditorChromeHostIdentifier);
    if (!chrome) return;
    const i18n = this.edgeless.std.getOptional(EditorI18nProvider) ?? undefined;
    void i18n?.locale$.value;
    const appTheme = this.edgeless.std.get(ThemeProvider).app$.value;
    const artwork = this._ensureArtwork();
    artwork.color = this._noteBg$.value;
    artwork.theme = appTheme;

    this.mountSlot("tool", this, chrome.mountCanvasTool, {
      expanded: this.popper !== null,
      action: {
        id: "canvas-note",
        label: resolveEditorMessage(
          editorMessage("com.myoxus.keyboardShortcuts.note", "Note"),
          i18n,
        ),
        shortcut: "N",
        active: this.active,
        disabled: false,
        run: () => this._toggleNoteMenu(),
      },
      artworkBounds: { width: 96, height: 64 },
      mountArtwork: this._mountArtwork,
    });
  }
}
