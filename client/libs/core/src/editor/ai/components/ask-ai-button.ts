import "./ask-ai-panel";

import { flip, offset } from "@floating-ui/dom";
import { HoverController } from "@virgultum/editor/components/hover";
import { createLitPortal } from "@virgultum/editor/components/portal";
import { WithDisposable } from "@virgultum/editor/global/lit";
import { unsafeCSSValue, unsafeCSSVar } from "@virgultum/editor/shared/theme";
import { type EditorHost } from "@virgultum/editor/std";
import { css, html, LitElement, nothing } from "lit";
import { property, query } from "lit/decorators.js";
import { ref } from "lit/directives/ref.js";

import { mantineLengthPx } from "../_common/mantine-length";
import type { AIItemGroupConfig } from "./ai-item/types";
import type { ButtonSize } from "./ask-ai-icon";
import type { AskAIPanelWidth } from "./ask-ai-panel";

type toggleType = "hover" | "click";
type AskAIButtonSurface = "transparent" | "overlay";

export type AskAIButtonOptions = {
  size: ButtonSize;
  surface?: AskAIButtonSurface;
  panelWidth?: AskAIPanelWidth;
};

export class AskAIButton extends WithDisposable(LitElement) {
  static override styles = css`
    .ask-ai-button {
      position: relative;
      user-select: none;
      border-radius: ${unsafeCSSValue("var(--mantine-radius-sm)")};
      background-color: transparent;
      box-shadow: none;
    }

    .ask-ai-button[data-surface="overlay"] {
      background-color: ${unsafeCSSVar("backgroundOverlayPanelColor")};
    }
  `;

  @query(".ask-ai-button")
  private accessor _askAIButton!: HTMLDivElement;

  private _abortController: AbortController | null = null;

  private readonly _whenHover = new HoverController(
    this,
    ({ abortController }) => {
      return {
        template: html`<ask-ai-panel
          .host=${this.host}
          .actionGroups=${this.actionGroups}
          .panelWidth=${this.options.panelWidth ?? "display"}
          .abortController=${abortController}
        ></ask-ai-panel>`,
        computePosition: {
          referenceElement: this,
          placement: "bottom-start",
          middleware: [flip(), offset(this._panelOffset())],
          autoUpdate: true,
        },
      };
    },
    {
      allowMultiple: true,
      enterDelay: 100,
    },
  );

  @property({ attribute: false })
  accessor host!: EditorHost;

  @property({ attribute: false })
  accessor actionGroups!: AIItemGroupConfig[];

  @property({ attribute: false })
  accessor toggleType: toggleType = "hover";

  @property({ attribute: false })
  accessor options: AskAIButtonOptions = {
    size: "small",
    surface: "transparent",
    panelWidth: "display",
  };

  private readonly _clearAbortController = () => {
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }
  };

  private readonly _toggleAIPanel = () => {
    if (this.toggleType !== "click") {
      return;
    }

    if (!this._askAIButton) {
      return;
    }

    if (this._abortController && !this._abortController.signal.aborted) {
      this._clearAbortController();
      return;
    }

    this._abortController = new AbortController();
    createLitPortal({
      template: html`<ask-ai-panel
        .host=${this.host}
        .actionGroups=${this.actionGroups}
        .panelWidth=${this.options.panelWidth ?? "display"}
      ></ask-ai-panel>`,
      container: this._askAIButton,
      computePosition: {
        referenceElement: this._askAIButton,
        placement: "bottom-start",
        middleware: [flip(), offset(this._panelOffset())],
        autoUpdate: true,
      },
      abortController: this._abortController,
      closeOnClickAway: true,
    });
  };

  private _panelOffset() {
    return {
      mainAxis: mantineLengthPx(this, "--mantine-spacing-sm"),
      crossAxis: -mantineLengthPx(
        this,
        "--mantine-spacing-2xs",
        "--mantine-spacing-xs",
      ),
    };
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._clearAbortController();
  }

  override render() {
    const { size, surface = "transparent" } = this.options;
    const { toggleType } = this;
    return html`<div
      class="ask-ai-button"
      data-testid="ask-ai-button"
      data-surface=${surface}
      ${toggleType === "hover" ? ref(this._whenHover.setReference) : nothing}
      @click=${this._toggleAIPanel}
    >
      <ask-ai-icon .size=${size}></ask-ai-icon>
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ask-ai-button": AskAIButton;
  }
}
