import * as icons from "@myoxus/icons/lit";
import { cssVar } from "@myoxus/theme";
import { type Signal } from "@preact/signals-core";
import { CaptionedBlockComponent } from "@virgultum/components/caption";
import {
  createPopup,
  popupTargetFromElement,
} from "@virgultum/components/context-menu";
import { DefaultInlineManagerExtension } from "@virgultum/inline-preset";
import {
  type CalloutBlockModel,
  normalizeCalloutAppearance,
  calloutPresentation,
  type ParagraphBlockModel,
} from "@virgultum/model";
import { focusTextModel } from "@virgultum/rich-text";
import { EDGELESS_TOP_CONTENTEDITABLE_SELECTOR } from "@virgultum/shared/consts";
import {
  DocModeProvider,
  type IconData,
  IconPickerServiceIdentifier,
  IconType,
} from "@virgultum/shared/services";
import type { UniComponent } from "@virgultum/shared/types";
import type { BlockComponent } from "@virgultum/std";
import { Text } from "@virgultum/store";
import { html, type TemplateResult } from "lit";
import { type StyleInfo, styleMap } from "lit/directives/style-map.js";

import {
  calloutBlockContainerStyles,
  calloutChildrenStyles,
  calloutEmojiContainerStyles,
  calloutEmojiStyles,
  calloutHostStyles,
} from "./callout-block-styles.js";
import { IconPickerWrapper } from "./icon-picker-wrapper.js";
import { CalloutTitleHostIdentifier } from "./react-host";
// Copy of renderUniLit and UniLit from myoxus-data-view
export const renderUniLit = <Props, Expose extends NonNullable<unknown>>(
  uni: UniComponent<Props, Expose> | undefined,
  props?: Props,
  options?: {
    ref?: Signal<Expose | undefined>;
    style?: Readonly<StyleInfo>;
    class?: string;
  },
): TemplateResult => {
  return html` <uni-lit
    .uni="${uni}"
    .props="${props}"
    .ref="${options?.ref}"
    style=${options?.style ? styleMap(options?.style) : ""}
  ></uni-lit>`;
};
const getIcon = (icon?: IconData) => {
  if (!icon) {
    return null;
  }
  if (icon.type === IconType.Emoji) {
    return icon.unicode;
  }
  if (icon.type === IconType.MyoxusIcon) {
    return (
      icons as Record<string, (props: { style: string }) => TemplateResult>
    )[`${icon.name}Icon`]?.({ style: `color:${icon.color}` });
  }
  return null;
};
export class CalloutBlockComponent extends CaptionedBlockComponent<CalloutBlockModel> {
  private _popupCloseHandler: (() => void) | null = null;
  // Viewing state is deliberately not a Yjs write or an undo/history entry.
  private _expanded: boolean | undefined;
  private _foldState = "";

  override connectedCallback() {
    super.connectedCallback();
    this.classList.add(calloutHostStyles);
  }

  private _getEmojiMarginTop(): string {
    if (this.model.children.length === 0) {
      return "10px";
    }

    const firstChild = this.model.children[0];
    const flavour = firstChild.flavour;

    const marginTopMap: Record<string, string> = {
      "myoxus:paragraph:h1": "23px",
      "myoxus:paragraph:h2": "20px",
      "myoxus:paragraph:h3": "16px",
      "myoxus:paragraph:h4": "15px",
      "myoxus:paragraph:h5": "14px",
      "myoxus:paragraph:h6": "13px",
    };

    // For heading blocks, use the type to determine margin
    if (flavour === "myoxus:paragraph") {
      const paragraph = firstChild as ParagraphBlockModel;
      const type = paragraph.props.type$.value;
      const key = `${flavour}:${type}`;
      return marginTopMap[key] || "10px";
    }

    // Default for all other block types
    return "10px";
  }

  private _closeIconPicker() {
    if (this._popupCloseHandler) {
      this._popupCloseHandler();
      this._popupCloseHandler = null;
    }
  }

  private _toggleIconPicker(event: MouseEvent) {
    if (this.store.readonly) return;
    // If popup is already open, close it
    if (this._popupCloseHandler) {
      this._closeIconPicker();
      return;
    }

    // Get IconPickerService from the framework
    const iconPickerService = this.std.getOptional(IconPickerServiceIdentifier);
    if (!iconPickerService) {
      console.warn("IconPickerService not found");
      return;
    }

    // Get the uni-component from the service
    const iconPickerComponent = iconPickerService.iconPickerComponent;

    // Create props for the icon picker
    const props = {
      onSelect: (iconData?: IconData) => {
        if (this.store.readonly) {
          this._closeIconPicker();
          return;
        }
        this.model.props.icon$.value = iconData;
        this._closeIconPicker(); // Close the picker after selection
      },
      onClose: () => {
        this._closeIconPicker();
      },
    };

    // Create IconPickerWrapper instance
    const wrapper = new IconPickerWrapper();
    wrapper.iconPickerComponent = iconPickerComponent;
    wrapper.props = props;
    wrapper.style.position = "absolute";
    wrapper.style.backgroundColor = cssVar("backgroundOverlayPanelColor");
    wrapper.style.boxShadow = "var(--myoxus-menu-shadow)";
    wrapper.style.borderRadius = "8px";

    // Create popup target from the clicked element
    const target = popupTargetFromElement(event.currentTarget as HTMLElement);

    // Create popup
    this._popupCloseHandler = createPopup(target, wrapper, {
      onClose: () => {
        this._popupCloseHandler = null;
      },
    });
  }

  private readonly _handleBlockClick = (event: MouseEvent) => {
    if (this.store.readonly) return;
    if (
      this.model.props.foldable &&
      !(this._expanded ?? this.model.props.defaultOpen !== false)
    )
      return;
    // Check if the click target is emoji related element
    const target = event.target as HTMLElement;
    if (target.closest("[data-callout-title]")) return;
    if (target.closest("rich-text")) {
      // Native title controls can leave browser focus outside the editor while
      // the pointer has already placed a valid caret in this rich-text body.
      this.topContenteditableElement?.focus({ preventScroll: true });
      return;
    }
    if (
      target.closest(".myoxus-callout-emoji-container") ||
      target.classList.contains("myoxus-callout-emoji")
    ) {
      return;
    }

    // If there's no icon, open icon picker on click
    const icon = this.model.props.icon$.value;
    if (!icon) {
      this._toggleIconPicker(event);
      return;
    }

    // Only handle clicks when there are no children
    if (this.model.children.length > 0) {
      return;
    }

    // Prevent event bubbling
    event.stopPropagation();

    // Create a new paragraph block
    const paragraphId = this.store.addBlock("myoxus:paragraph", {}, this.model);

    // Focus the new paragraph
    focusTextModel(this.std, paragraphId);
  };

  get attributeRenderer() {
    return this.inlineManager.getRenderer();
  }

  get attributesSchema() {
    return this.inlineManager.getSchema();
  }

  get embedChecker() {
    return this.inlineManager.embedChecker;
  }

  get inlineManager() {
    return this.std.get(DefaultInlineManagerExtension.identifier);
  }

  override get topContenteditableElement() {
    if (this.std.get(DocModeProvider).getEditorMode() === "edgeless") {
      return this.closest<BlockComponent>(
        EDGELESS_TOP_CONTENTEDITABLE_SELECTOR,
      );
    }
    return this.rootComponent;
  }

  override renderBlock() {
    const type = this.model.props.type$.value;
    const foldable = this.model.props.foldable$.value === true;
    const defaultOpen = this.model.props.defaultOpen$.value !== false;
    const foldState = `${foldable}:${defaultOpen}`;
    if (foldState !== this._foldState) {
      this._foldState = foldState;
      this._expanded = undefined;
    }
    const expanded = !foldable || (this._expanded ?? defaultOpen);
    const title = this.model.props.title;
    const titleValue =
      title?.deltas$.value.map((delta) => delta.insert ?? "").join("") ?? "";
    const titleHost = this.std.getOptional(CalloutTitleHostIdentifier);
    const icon = this.model.props.icon$.value;
    const backgroundColorName = this.model.props.backgroundColorName$.value;
    const normalizedBackgroundName =
      backgroundColorName === "default" || backgroundColorName === ""
        ? "grey"
        : backgroundColorName;
    const backgroundColor =
      normalizedBackgroundName === "grey"
        ? cssVar("tagGray")
        : cssVar(
            `--myoxus-text-highlight-${normalizedBackgroundName ?? "grey"}`,
          );
    const emphasisColor = cssVar(
      `--myoxus-text-highlight-foreground-${normalizedBackgroundName ?? "grey"}`,
    );
    const appearance =
      normalizeCalloutAppearance(this.model.props.appearance$.value) ?? "soft";
    const appearanceStyles: StyleInfo =
      appearance === "accent"
        ? {
            backgroundColor: cssVar("backgroundSecondaryColor"),
            borderInlineStart: `3px solid ${emphasisColor}`,
          }
        : appearance === "outline"
          ? {
              backgroundColor: cssVar("backgroundPrimaryColor"),
              border: `1px solid ${emphasisColor}`,
            }
          : { backgroundColor };

    const iconContent = getIcon(icon);

    return html`
      <div
        class="${calloutBlockContainerStyles}"
        data-callout-appearance=${appearance}
        @click=${this._handleBlockClick}
        style=${styleMap(appearanceStyles)}
      >
        ${
          iconContent
            ? html`
                <div
                  @click=${this._toggleIconPicker}
                  contenteditable="false"
                  class="${calloutEmojiContainerStyles}"
                  style=${styleMap({
                    // Typed callouts align their icon with the title row;
                    // untitled callouts still follow the first body's heading.
                    marginTop: type ? "0" : this._getEmojiMarginTop(),
                  })}
                >
                  <span
                    class="${calloutEmojiStyles}"
                    data-testid="callout-emoji"
                    >${iconContent}</span
                  >
                </div>
              `
            : ""
        }
        <div class="${calloutChildrenStyles}">
          ${
            type
              ? html` <div contenteditable="false" data-callout-title>
                  ${
                    titleHost?.render({
                      type,
                      foldable,
                      defaultOpen,
                      expanded,
                      toggle: () => {
                        this._expanded = !expanded;
                        this.requestUpdate();
                      },
                      applySettings: (value) => {
                        if (
                          this.store.readonly ||
                          this.store.getModelById(this.model.id) !==
                            this.model ||
                          this.model.props.type !== type ||
                          (this.model.props.foldable === true) !== foldable ||
                          (this.model.props.defaultOpen !== false) !==
                            defaultOpen ||
                          !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(value.type)
                        )
                          return false;
                        if (
                          value.type === type &&
                          value.foldable === foldable &&
                          value.defaultOpen === defaultOpen
                        )
                          return true;
                        this.store.captureSync();
                        this.store.updateBlock(this.model, {
                          ...value,
                          ...(value.type !== type
                            ? {
                                icon: {
                                  type: IconType.Emoji,
                                  unicode: calloutPresentation(value.type).icon,
                                },
                                backgroundColorName: calloutPresentation(
                                  value.type,
                                ).background,
                              }
                            : {}),
                        });
                        this.store.captureSync();
                        return true;
                      },
                      title: titleValue,
                      readonly: this.store.readonly$.value,
                      focusEditor: async () => {
                        if (this.store.readonly) return;
                        if (!expanded) {
                          this._expanded = true;
                          this.requestUpdate();
                          await this.updateComplete;
                        }
                        if (
                          !this.isConnected ||
                          this.store.readonly ||
                          this.store.getModelById(this.model.id) !== this.model
                        )
                          return;
                        // A native title input owns focus outside the rich-text
                        // range. Return both browser focus and editor selection.
                        this.topContenteditableElement?.focus({
                          preventScroll: true,
                        });
                        const target =
                          this.model.props.text.length ||
                          !this.model.children.length
                            ? this.model
                            : this.model.children[0];
                        focusTextModel(
                          this.std,
                          target.id,
                          target.text?.length ?? 0,
                        );
                      },
                      apply: (value, expectedTitle) => {
                        if (
                          this.store.readonly ||
                          this.store.getModelById(this.model.id) !==
                            this.model ||
                          /[\r\n]/.test(value)
                        )
                          return false;
                        const current = this.model.props.title;
                        if ((current?.toString() ?? "") !== expectedTitle)
                          return false;
                        if (expectedTitle === value) return true;
                        this.store.captureSync();
                        if (current)
                          current.replace(0, current.length, value, {});
                        else
                          this.store.updateBlock(this.model, {
                            title: new Text(value),
                          });
                        this.store.captureSync();
                        return true;
                      },
                    }) ?? titleValue
                  }
                </div>`
              : ""
          }
          <div ?hidden=${!expanded} data-callout-body>
            ${
              this.model.props.text.deltas$.value.length ||
              this.model.children.length === 0
                ? html` <rich-text
                    .yText=${this.model.props.text.yText}
                    .inlineEventSource=${this.topContenteditableElement}
                    .undoManager=${this.store.history.undoManager}
                    .attributesSchema=${this.attributesSchema}
                    .attributeRenderer=${this.attributeRenderer}
                    .markdownMatches=${this.inlineManager.markdownMatches}
                    .embedChecker=${this.embedChecker}
                    .readonly=${this.store.readonly}
                    .enableClipboard=${false}
                    .enableUndoRedo=${false}
                  ></rich-text>`
                : ""
            }
            ${this.renderChildren(this.model)}
          </div>
        </div>
      </div>
    `;
  }
}
