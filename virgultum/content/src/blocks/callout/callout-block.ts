import { computed, effect, signal } from "@preact/signals-core";
import { type CalloutBlockModel } from "@virgultum/core/models";
import { EDGELESS_TOP_CONTENTEDITABLE_SELECTOR } from "@virgultum/core/consts";
import {
  DocModeProvider,
  EditorI18nProvider,
  textProtectionHint,
} from "@virgultum/core/services";
import {
  NativeContainerBlock,
  type BlockComponent,
} from "@virgultum/core/runtime";
import { DefaultInlineManagerExtension } from "../../inlines/preset/index";
import { focusTextModel } from "../../rich-text/index";
import { selectionFrame } from "../../caption/selection-frame";
import {
  calloutBlockContainerStyles,
  calloutChildrenStyles,
  calloutEmojiContainerStyles,
  calloutEmojiStyles,
  calloutHostStyles,
  calloutIconOffset,
  calloutSurface,
} from "./callout-block-styles";
import { openCalloutIconPicker } from "./icon-picker-wrapper";
import {
  CalloutTitleHostIdentifier,
  type CalloutTitleHostProps,
} from "./react-host";

export class CalloutBlockComponent extends NativeContainerBlock<CalloutBlockModel> {
  protected readonly blockStyles = "";
  override get topContenteditableElement() {
    return this.std.get(DocModeProvider).getEditorMode() === "edgeless"
      ? this.closest<BlockComponent>(EDGELESS_TOP_CONTENTEDITABLE_SELECTOR)
      : this.rootComponent;
  }
  protected mountBody() {
    const { model, store, ownerDocument: doc } = this;
    const host = this.std.getOptional(CalloutTitleHostIdentifier);
    this.classList.add(calloutHostStyles);
    const surface = doc.createElement("div");
    surface.className = calloutBlockContainerStyles;
    const glyph = doc.createElement("div");
    glyph.className = calloutEmojiContainerStyles;
    glyph.contentEditable = "false";
    const icon = doc.createElement("span");
    icon.className = calloutEmojiStyles;
    icon.dataset.testid = "callout-emoji";
    glyph.append(icon);
    const content = doc.createElement("div");
    content.className = calloutChildrenStyles;
    const title = doc.createElement("div");
    title.contentEditable = "false";
    title.dataset.calloutTitle = "";
    const body = doc.createElement("div");
    body.dataset.calloutBody = "";
    const children = doc.createElement("div");
    children.className = "myoxus-block-children-container";
    body.append(children);
    content.append(title, body);
    surface.append(glyph, content);
    this.append(selectionFrame(this, surface));
    this.mountBlockWidgets(surface);
    const manager = this.std.get(DefaultInlineManagerExtension.identifier);
    const input = doc.createElement("rich-text");
    input.inlineEventSource = this.topContenteditableElement ?? undefined;
    input.undoManager = store.history.undoManager;
    input.attributesSchema = manager.getSchema();
    input.attributeRenderer = manager.getRenderer();
    input.markdownMatches = manager.markdownMatches;
    input.embedChecker = manager.embedChecker;
    input.enableClipboard = false;
    input.enableUndoRedo = false;
    this.disposables.add(
      effect(() => {
        const props = model.props,
          text = props.text$.value;
        input.yText = text.yText;
        input.readonly =
          store.readonly || props.textProtection$.value === "fixed";
        input.title =
          textProtectionHint(
            props.textProtection$.value,
            this.std.getOptional(EditorI18nProvider) ?? undefined,
          ) ?? "";
        if (text.deltas$.value.length || !model.children.length) {
          if (!input.parentElement) body.prepend(input);
        } else input.remove();
      }),
    );
    const folded = signal<{ policy: string; open: boolean } | undefined>(
      undefined,
    );
    const policy = computed(
      () =>
        `${!!model.props.foldable$.value}:${model.props.defaultOpen$.value !== false}`,
    );
    const expanded = computed(
      () =>
        !model.props.foldable$.value ||
        (folded.value?.policy === policy.value
          ? folded.value.open
          : model.props.defaultOpen$.value !== false),
    );
    const writable = () =>
      this.isConnected &&
      !store.readonly &&
      store.getModelById(model.id) === model;
    const titleState = computed<CalloutTitleHostProps>(() => {
      const props = model.props,
        type = props.type$.value;
      const foldable = props.foldable$.value === true,
        defaultOpen = props.defaultOpen$.value !== false;
      return {
        type,
        foldable,
        defaultOpen,
        expanded: expanded.value,
        title:
          props.title$.value?.deltas$.value.map((d) => d.insert).join("") ?? "",
        readonly: store.readonly || props.textProtection$.value === "fixed",
        toggle: () => {
          folded.value = { policy: policy.value, open: !expanded.value };
        },
        apply: (value, base) => writable() && model.applyTitle(value, base),
        applySettings: (value) =>
          writable() &&
          !!type &&
          model.applySettings(value, { type, foldable, defaultOpen }),
        focusEditor: () => {
          if (!writable()) return;
          folded.value = { policy: policy.value, open: true };
          void this.updateComplete.then(() => {
            if (!writable()) return;
            this.topContenteditableElement?.focus({ preventScroll: true });
            const target =
              model.props.text.length || !model.children.length
                ? model
                : model.children[0];
            focusTextModel(this.std, target.id, target.text?.length ?? 0);
          });
        },
      };
    });
    const iconState = computed(() => model.props.icon$.value);
    this.disposables.add(
      effect(() => {
        const current = iconState.value;
        if (current && current.type !== "blob") {
          if (glyph.parentElement !== surface) surface.prepend(glyph);
          glyph.style.marginTop = calloutIconOffset(model);
        } else glyph.remove();
        body.hidden = !expanded.value;
        title.hidden = !model.props.type$.value;
        const { appearance, style } = calloutSurface(model);
        surface.dataset.calloutAppearance = appearance;
        Object.assign(surface.style, style);
      }),
    );
    if (host) {
      this.disposables.add(host.mountIcon(icon, iconState));
      this.disposables.add(host.mountTitle(title, titleState));
    } else {
      this.disposables.add(
        effect(() => {
          title.textContent = titleState.value.title;
          const value = iconState.value;
          icon.textContent = value?.type === "emoji" ? value.unicode : "";
        }),
      );
    }
    let closePicker: (() => void) | undefined;
    const pick = (anchor: HTMLElement) => {
      if (closePicker) {
        closePicker();
        return;
      }
      closePicker = openCalloutIconPicker(this.std, model, anchor, () => {
        closePicker = undefined;
      });
    };
    this.disposables.add(() => closePicker?.());
    this.disposables.addFromEvent(surface, "click", (event) => {
      if (
        !writable() ||
        !(event.target instanceof Element) ||
        title.contains(event.target)
      )
        return;
      if (glyph.contains(event.target)) {
        pick(glyph);
        return;
      }
      if (!expanded.value) return;
      if (event.target.closest("rich-text")) {
        this.topContenteditableElement?.focus({ preventScroll: true });
        return;
      }
      if (!iconState.value) {
        pick(surface);
        return;
      }
      if (model.children.length) return;
      event.stopPropagation();
      const id = store.addBlock("myoxus:paragraph", {}, model);
      focusTextModel(this.std, id);
    });
    return children;
  }
}
