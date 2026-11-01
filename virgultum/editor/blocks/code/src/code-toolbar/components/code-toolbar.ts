import { flip, offset } from "@floating-ui/dom";
import { MoreVerticalIcon } from "@myoxus/icons/lit";
import { createLitPortal } from "@virgultum/components/portal";
import {
  type EditorIconButton,
  type MenuItemGroup,
  renderGroups,
} from "@virgultum/components/toolbar";
import { WithDisposable } from "@virgultum/global/lit";
import { noop } from "@virgultum/global/utils";
import {
  EditorI18nProvider,
  resolveLegacyEditorText,
} from "@virgultum/shared/services";
import { unsafeCSSValue, unsafeCSSVar } from "@virgultum/shared/theme";
import { css, html, LitElement } from "lit";
import { property, query, state } from "lit/decorators.js";
import { styleMap } from "lit/directives/style-map.js";

import type { CodeBlockToolbarContext } from "../context.js";

export class MyoxusCodeToolbar extends WithDisposable(LitElement) {
  static override styles = css`
    :host {
      position: absolute;
      width: 100%;
      top: 0;
      left: 0;
    }

    .code-toolbar-container {
      width: auto;
      height: ${unsafeCSSValue("var(--mantine-spacing-xl)")};
      gap: ${unsafeCSSValue("var(--mantine-spacing-xs)")};
      padding: ${unsafeCSSValue("var(--mantine-spacing-xs)")};
      margin: 0;
      display: flex;
    }

    .code-toolbar-button {
      color: ${unsafeCSSVar("iconColor")};
      background-color: ${unsafeCSSVar("backgroundPrimaryColor")};
      box-shadow: ${unsafeCSSValue("var(--mantine-shadow-sm)")};
      border-radius: ${unsafeCSSValue("var(--mantine-radius-sm)")};
    }
  `;

  private _currentOpenMenu: AbortController | null = null;

  private _popMenuAbortController: AbortController | null = null;

  closeCurrentMenu = () => {
    if (this._currentOpenMenu && !this._currentOpenMenu.signal.aborted) {
      this._currentOpenMenu.abort();
      this._currentOpenMenu = null;
    }
  };

  private _toggleMoreMenu() {
    if (
      this._currentOpenMenu &&
      !this._currentOpenMenu.signal.aborted &&
      this._currentOpenMenu === this._popMenuAbortController
    ) {
      this.closeCurrentMenu();
      this._moreMenuOpen = false;
      return;
    }

    this.closeCurrentMenu();
    this._popMenuAbortController = new AbortController();
    this._popMenuAbortController.signal.addEventListener("abort", () => {
      this._moreMenuOpen = false;
      this.onActiveStatusChange(false);
    });
    this.onActiveStatusChange(true);

    this._currentOpenMenu = this._popMenuAbortController;

    if (!this._moreButton) {
      console.error(
        "Failed to open more menu in code toolbar! Unexpected missing more button",
      );
      return;
    }

    createLitPortal({
      template: html`
        <editor-menu-content
          data-show
          class="more-popup-menu"
          style=${styleMap({
            "--content-padding": "var(--mantine-spacing-sm)",
            "--packed-height": "var(--mantine-spacing-xs)",
          })}
        >
          <div data-size="large" data-orientation="vertical">
            ${renderGroups(this.moreGroups, this.context)}
          </div>
        </editor-menu-content>
      `,
      // should be greater than block-selection z-index as selection and popover wil share the same stacking context(editor-host)
      portalStyles: {
        zIndex: "var(--myoxus-z-index-popover)",
      },
      container: this.context.host,
      computePosition: {
        referenceElement: this._moreButton,
        placement: "bottom-start",
        middleware: [flip(), offset(4)],
        autoUpdate: { animationFrame: true },
      },
      abortController: this._popMenuAbortController,
      closeOnClickAway: true,
    });
    this._moreMenuOpen = true;
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.closeCurrentMenu();
  }

  override render() {
    const i18n =
      this.context.host.std.getOptional(EditorI18nProvider) ?? undefined;
    const text = (value: string) =>
      resolveLegacyEditorText(value, i18n) ?? value;

    return html`
      <editor-toolbar class="code-toolbar-container" data-without-bg>
        ${renderGroups(this.primaryGroups, this.context)}
        <editor-icon-button
          class="code-toolbar-button more"
          data-testid="more"
          aria-label=${text("More")}
          .tooltip=${text("More")}
          .tooltipOffset=${4}
          .iconSize=${"16px"}
          .iconContainerPadding=${4}
          .showTooltip=${!this._moreMenuOpen}
          ?disabled=${this.context.doc.readonly}
          @click=${() => this._toggleMoreMenu()}
        >
          ${MoreVerticalIcon()}
        </editor-icon-button>
      </editor-toolbar>
    `;
  }

  @query(".code-toolbar-button.more")
  private accessor _moreButton!: EditorIconButton;

  @state()
  private accessor _moreMenuOpen = false;

  @property({ attribute: false })
  accessor context!: CodeBlockToolbarContext;

  @property({ attribute: false })
  accessor moreGroups!: MenuItemGroup<CodeBlockToolbarContext>[];

  @property({ attribute: false })
  accessor onActiveStatusChange: (active: boolean) => void = noop;

  @property({ attribute: false })
  accessor primaryGroups!: MenuItemGroup<CodeBlockToolbarContext>[];
}
