import {
  ArrowDownSmallIcon,
  ArrowUpSmallIcon,
  CloseIcon,
  DoneIcon,
} from "@myoxus/icons/lit";
import { track } from "@myoxus/track";
import { fontSMStyle } from "@virgultum/editor/shared/styles";
import { WidgetComponent, WidgetViewExtension } from "@virgultum/editor/std";
import { unsafeCSSValue, unsafeCSSVar } from "@virgultum/shared/theme";
import { css, html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { literal, unsafeStatic } from "lit/static-html.js";

import { BlockDiffProvider } from "../../services/block-diff";

export const MYOXUS_BLOCK_DIFF_WIDGET_FOR_PAGE =
  "myoxus-block-diff-widget-for-page";

export class MyoxusBlockDiffWidgetForPage extends WidgetComponent {
  static override styles = css`
    .ai-block-diff-scroller-container {
      position: fixed;
      left: 50%;
      transform: translateX(-50%);
      bottom: calc(
        ${unsafeCSSValue(
          "calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm))",
        )} *
          4 +
          ${unsafeCSSValue(
            "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
          )}
      );
      margin: 0;
      display: flex;
      gap: ${unsafeCSSValue("var(--mantine-spacing-xs)")};
      justify-content: center;
      align-items: center;
      background-color: ${unsafeCSSVar("backgroundOverlayPanelColor")};
      box-shadow: ${unsafeCSSValue("var(--mantine-shadow-sm)")};
      border-radius: ${unsafeCSSValue("var(--mantine-radius-lg)")};
      inline-size: max-content;
      padding: ${unsafeCSSValue("var(--mantine-spacing-sm)")}
        ${unsafeCSSValue("var(--mantine-spacing-xs)")};
      cursor: pointer;
    }

    .ai-block-diff-scroller {
      display: flex;
      align-items: center;
      gap: ${unsafeCSSValue("var(--mantine-spacing-xs)")};
    }

    .ai-block-diff-scroller span {
      display: inline-flex;
    }

    .ai-block-diff-scroller svg {
      color: ${unsafeCSSVar("iconColor")};
    }

    .ai-block-diff-all-option {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: ${unsafeCSSValue("var(--mantine-spacing-sm)")};
      padding: ${unsafeCSSValue("var(--mantine-spacing-xs)")}
        ${unsafeCSSValue("var(--mantine-spacing-sm)")};
    }

    .ai-block-diff-all-option.reject svg {
      color: ${unsafeCSSVar("iconSecondary")};
    }

    .ai-block-diff-all-option.accept svg {
      color: ${unsafeCSSVar("primaryColor")};
    }

    ${fontSMStyle(".ai-block-diff-scroller-container")}
  `;

  @property({ type: Number })
  accessor currentIndex = 0;

  _handleScroll(dir: "prev" | "next") {
    const total = this.diffService.getTotalDiffs();

    const diffWidgets = Array.from(
      this.std.host.querySelectorAll("myoxus-block-diff-widget-for-block"),
    );
    const diffs = diffWidgets.reduce<Element[]>((acc, widget) => {
      const aiDiffs = widget.shadowRoot?.querySelectorAll(".ai-block-diff");
      if (aiDiffs && aiDiffs.length > 0) {
        acc.push(...aiDiffs);
      }
      return acc;
    }, []);
    if (dir === "prev") {
      this.currentIndex = Math.max(0, this.currentIndex - 1);
    } else {
      this.currentIndex = Math.min(total - 1, this.currentIndex + 1);
    }
    diffs[this.currentIndex].scrollIntoView({ behavior: "smooth" });
  }

  async _handleAcceptAll() {
    track.applyModel.widget.page.acceptAll();
    await this.diffService.acceptAll(this.std.store);
  }

  _handleRejectAll() {
    track.applyModel.widget.page.rejectAll();
    this.diffService.rejectAll();
  }

  get diffService() {
    return this.std.get(BlockDiffProvider);
  }

  override render() {
    if (!this.diffService.hasDiff()) {
      return nothing;
    }

    const total = this.diffService.getTotalDiffs();

    return total === 0
      ? null
      : html`
          <div class="ai-block-diff-scroller-container">
            <div class="ai-block-diff-scroller">
              <span @click=${() => this._handleScroll("next")}
                >${ArrowDownSmallIcon()}</span
              >
              <span class="ai-block-diff-scroller-current"
                >${Math.min(this.currentIndex + 1, total)}</span
              >
              <span>/</span>
              <span class="ai-block-diff-scroller-total">${total}</span>
              <span @click=${() => this._handleScroll("prev")}
                >${ArrowUpSmallIcon()}</span
              >
            </div>
            <div
              class="ai-block-diff-all-option reject"
              @click=${() => this._handleRejectAll()}
            >
              ${CloseIcon()} Reject all
            </div>
            <div
              class="ai-block-diff-all-option accept"
              @click=${() => this._handleAcceptAll()}
            >
              ${DoneIcon()} Accept all
            </div>
          </div>
        `;
  }

  override connectedCallback() {
    super.connectedCallback();

    this.disposables.add(
      this.diffService.diffMap$.subscribe(() => {
        this.requestUpdate();
      }),
    );

    this.disposables.add(
      this.diffService.rejects$.subscribe(() => {
        this.requestUpdate();
      }),
    );
  }
}

export const blockDiffWidgetForPage = WidgetViewExtension(
  "myoxus:page",
  MYOXUS_BLOCK_DIFF_WIDGET_FOR_PAGE,
  literal`${unsafeStatic(MYOXUS_BLOCK_DIFF_WIDGET_FOR_PAGE)}`,
);
