import {
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  Heading4Icon,
  Heading5Icon,
  Heading6Icon,
} from "@myoxus/icons/native";
import { computed, effect, signal } from "@preact/signals-core";
import type { ParagraphBlockModel } from "@virgultum/core/models";
import {
  BlockElementCommentManager,
  CitationProvider,
} from "@virgultum/core/services";
import {
  calculateCollapsedSiblings,
  getNearestHeadingBefore,
} from "@virgultum/core/utils";
import { TextSelection } from "@virgultum/core/runtime";
import { TextBlock } from "../../rich-text/text-block";

import { ParagraphBlockConfigExtension } from "./paragraph-block-config";
import { paragraphBlockStyles } from "./styles";

const headingIcons = {
  h1: Heading1Icon,
  h2: Heading2Icon,
  h3: Heading3Icon,
  h4: Heading4Icon,
  h5: Heading5Icon,
  h6: Heading6Icon,
};

export class ParagraphBlockComponent extends TextBlock<ParagraphBlockModel> {
  protected readonly blockStyles = paragraphBlockStyles;
  focused$ = computed(() => {
    const selection = this.std.selection.value.find(
      (selection) => selection.blockId === this.model?.id,
    );
    if (!selection) return false;
    return selection.is(TextSelection);
  });

  private readonly _composing = signal(false);

  private get _placeholder() {
    return this.std
      .get(ParagraphBlockConfigExtension.identifier)
      ?.getPlaceholder(this.model);
  }

  get citationService() {
    return this.std.get(CitationProvider);
  }

  get collapsedSiblings() {
    return calculateCollapsedSiblings(this.model);
  }

  get inEdgelessText() {
    return (
      this.topContenteditableElement?.tagName.toLowerCase() ===
      "myoxus-edgeless-text"
    );
  }

  get hasCitationSiblings() {
    return this.collapsedSiblings.some((sibling) =>
      this.citationService.isCitationModel(sibling),
    );
  }

  get isCommentHighlighted() {
    return (
      this.std
        .getOptional(BlockElementCommentManager)
        ?.isBlockCommentHighlighted(this.model) ?? false
    );
  }

  protected showDisclosure() {
    return (
      this.model.props.type$.value.startsWith("h") &&
      this.collapsedSiblings.length > 0
    );
  }
  protected override setCollapsed(value: boolean) {
    super.setCollapsed(value);
    if (this.hasCitationSiblings)
      this.citationService.trackEvent("Expand", {
        control: "Source Button",
        type: value ? "Hide" : "Show",
      });
  }
  protected mountControls(container: HTMLElement, line: HTMLElement) {
    this.handleEvent(
      "compositionStart",
      () => {
        this._composing.value = true;
      },
      { flavour: true },
    );
    this.handleEvent(
      "compositionEnd",
      () => {
        this._composing.value = false;
      },
      { flavour: true },
    );

    this.disposables.add(
      effect(() => {
        const type = this.model.props.type$.value;
        if (!type.startsWith("h") && this.model.props.collapsed) {
          this.model.props.collapsed = false;
        }
      }),
    );

    this.disposables.add(
      effect(() => {
        const collapsed = this.model.props.collapsed$.value;

        // reset text selection when selected block is collapsed
        if (this.model.props.type$.value.startsWith("h") && collapsed) {
          const collapsedSiblings = this.collapsedSiblings;
          const textSelection = this.host.selection.find(TextSelection);

          if (
            textSelection &&
            collapsedSiblings.some(
              (sibling) => sibling.id === textSelection.blockId,
            )
          ) {
            this.host.selection.clear(["text"]);
          }
        }
      }),
    );

    // > # 123
    // # 456
    //
    // we need to update collapsed state of 123 when 456 converted to text
    let beforeType = this.model.props.type$.peek();
    this.disposables.add(
      effect(() => {
        const type = this.model.props.type$.value;
        if (beforeType !== type && !type.startsWith("h")) {
          const nearestHeading = getNearestHeadingBefore(this.model);
          if (
            nearestHeading &&
            nearestHeading.props.type.startsWith("h") &&
            nearestHeading.props.collapsed &&
            !this.store.readonly
          ) {
            nearestHeading.props.collapsed = false;
          }
        }
        beforeType = type;
      }),
    );

    const doc = this.ownerDocument;
    const heading = doc.createElement("div");
    heading.className = "heading-icon";
    const placeholder = doc.createElement("div");
    placeholder.contentEditable = "false";
    placeholder.className = "myoxus-paragraph-placeholder";
    if (!this.inEdgelessText) line.append(placeholder);
    const visibility = doc.createElement("style");
    let previousType = "";
    this.disposables.add(
      effect(() => {
        const type = this.model.props.type$.value;
        if (previousType) line.classList.remove(previousType);
        line.classList.add(type);
        previousType = type;
        line.classList.toggle(
          "eyebrow",
          type === "text" &&
            this.model.props.presentation$?.value === "eyebrow",
        );
        container.classList.toggle(
          "highlight-comment",
          this.isCommentHighlighted,
        );
        const siblings = type.startsWith("h") ? this.collapsedSiblings : [];
        container.dataset.hasCollapsedSiblings = String(siblings.length > 0);
        if (type !== "text" && type !== "quote") {
          if (heading.dataset.testid !== "heading-icon-" + type.slice(1)) {
            heading.dataset.testid = "heading-icon-" + type.slice(1);
            heading.innerHTML = headingIcons[type];
          }
          if (!heading.parentNode) line.prepend(heading);
        } else heading.remove();
        if (type.startsWith("h") && this.collapsed && siblings.length) {
          container.setAttribute("data-heading-folded", "");
          const owner =
            'myoxus-paragraph[data-block-id="' +
            CSS.escape(this.blockId) +
            '"]:has(> .myoxus-block-component > [data-heading-folded]) ~ ';
          visibility.textContent =
            siblings
              .map(
                (sibling) =>
                  owner + '[data-block-id="' + CSS.escape(sibling.id) + '"]',
              )
              .join(",") + "{display:none!important}";
          if (!visibility.parentNode) container.append(visibility);
        } else {
          visibility.remove();
          container.removeAttribute("data-heading-folded");
        }
      }),
    );
    this.disposables.add(
      effect(() => {
        placeholder.textContent = this._placeholder ?? "";
        placeholder.classList.toggle(
          "visible",
          !this.store.readonly &&
            !this._composing.value &&
            this.focused$.value &&
            this.host.selection.find(TextSelection)?.isCollapsed() === true &&
            this.model.props.text$.value.length === 0 &&
            !this.closest("myoxus-database"),
        );
      }),
    );
  }
}
