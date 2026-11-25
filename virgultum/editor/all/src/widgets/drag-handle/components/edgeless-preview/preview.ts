import {
  EmbedIcon,
  FrameIcon,
  ImageIcon,
  PageIcon,
  ShapeIcon,
} from "@myoxus/icons/native";
import { NativeViewElement } from "@virgultum/core/primitives/env";
import {
  editorMessage,
  resolveEditorMessage,
  type EditorI18nMessage,
  type EditorI18nService,
} from "@virgultum/core/services";
import { unsafeCSSVar } from "@virgultum/core/theme";

const BLOCK_PREVIEW_ICON_MAP: Record<
  string,
  {
    icon: string;
    name: EditorI18nMessage;
  }
> = {
  shape: {
    icon: ShapeIcon,
    name: editorMessage(
      "com.myoxus.editor.drag-preview.shape",
      "Edgeless shape",
    ),
  },
  "myoxus:image": {
    icon: ImageIcon,
    name: editorMessage("com.myoxus.editor.drag-preview.image", "Image block"),
  },
  "myoxus:note": {
    icon: PageIcon,
    name: editorMessage("com.myoxus.editor.drag-preview.note", "Note block"),
  },
  "myoxus:frame": {
    icon: FrameIcon,
    name: editorMessage("com.myoxus.editor.drag-preview.frame", "Frame block"),
  },
  "myoxus:embed-": {
    icon: EmbedIcon,
    name: editorMessage("com.myoxus.editor.drag-preview.embed", "Embed block"),
  },
};

const STYLES = `
  .edgeless-dnd-preview-container {
    position: relative;
    padding: 12px;
    width: 264px;
    height: 80px;
  }

  .edgeless-dnd-preview-block {
    display: flex;
    position: absolute;

    width: 234px;

    align-items: flex-start;
    box-sizing: border-box;

    border-radius: 8px;
    background-color: ${unsafeCSSVar("backgroundOverlayPanelColor")};

    padding: 8px 20px;
    gap: 8px;

    transform-origin: center;

    font-family: var(--myoxus-font-family);
    box-shadow: 0px 0px 0px 0.5px ${unsafeCSSVar("borderColor")} inset;
  }

  .edgeless-dnd-preview-block > svg {
    color: ${unsafeCSSVar("iconColor")};
    width: 24px;
    height: 24px;
    flex-shrink: 0;
  }

  .edgeless-dnd-preview-block > .text {
    color: ${unsafeCSSVar("textPrimaryColor")};
    font-size: 14px;
    line-height: 24px;
  }
`;

declare global {
  interface HTMLElementTagNameMap {
    "edgeless-dnd-preview-element": EdgelessDndPreviewElement;
  }
}

export const EDGELESS_DND_PREVIEW_ELEMENT = "edgeless-dnd-preview-element";

export class EdgelessDndPreviewElement extends NativeViewElement {
  private _elementTypes: { type: string }[] = [];
  private _i18n: EditorI18nService | undefined;
  private readonly _shadow: ShadowRoot;
  private readonly _container: HTMLDivElement;

  constructor() {
    super();
    this._shadow = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = STYLES;
    this._container = document.createElement("div");
    this._container.className = "edgeless-dnd-preview-container";
    this._shadow.append(style, this._container);
  }

  get elementTypes(): { type: string }[] {
    return this._elementTypes;
  }

  set elementTypes(value: { type: string }[]) {
    this._elementTypes = value ?? [];
    this._render();
  }

  get i18n(): EditorI18nService | undefined {
    return this._i18n;
  }

  set i18n(value: EditorI18nService | undefined) {
    this._i18n = value;
    this._render();
  }

  connectedCallback() {
    this._render();
  }

  private _getPreviewIcon(type: string) {
    if (BLOCK_PREVIEW_ICON_MAP[type]) {
      return BLOCK_PREVIEW_ICON_MAP[type];
    }

    if (type.startsWith("myoxus:embed-")) {
      return BLOCK_PREVIEW_ICON_MAP["myoxus:embed-"];
    }

    return {
      icon: ShapeIcon,
      name: editorMessage(
        "com.myoxus.editor.surface-ref.content",
        "Edgeless content",
      ),
    };
  }

  private _render() {
    this._container.replaceChildren();
    this._elementTypes.slice(0, 3).forEach(({ type }, index) => {
      const { icon, name } = this._getPreviewIcon(type);
      const block = document.createElement("div");
      block.className = "edgeless-dnd-preview-block";
      block.style.transform = `rotate(${index * -2}deg)`;
      block.style.zIndex = String(3 - index);

      const template = document.createElement("template");
      template.innerHTML = icon.trim();
      const svg = template.content.firstElementChild;
      if (svg instanceof SVGElement) {
        svg.setAttribute("width", "24px");
        svg.setAttribute("height", "24px");
        block.append(svg);
      }

      const text = document.createElement("span");
      text.className = "text";
      text.textContent = resolveEditorMessage(name, this._i18n);
      block.append(text);

      this._container.append(block);
    });
  }
}
