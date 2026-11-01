import {
  type FilterableListItem,
  type FilterableListOptions,
  showPopFilterableList,
} from "@virgultum/components/filterable-list";
import { ArrowDownIcon } from "@virgultum/components/icons";
import { SignalWatcher, WithDisposable } from "@virgultum/global/lit";
import { noop } from "@virgultum/global/utils";
import {
  DocModeProvider,
  EditorI18nProvider,
  TelemetryProvider,
  editorMessage,
} from "@virgultum/shared/services";
import { unsafeCSSValue, unsafeCSSVar } from "@virgultum/shared/theme";
import { css, LitElement, nothing } from "lit";
import { property, query } from "lit/decorators.js";
import { styleMap } from "lit/directives/style-map.js";
import { html } from "lit/static-html.js";

import type { CodeBlockComponent } from "../..";

export class LanguageListButton extends WithDisposable(
  SignalWatcher(LitElement),
) {
  static override styles = css`
    .lang-button {
      display: flex;
      gap: ${unsafeCSSValue("var(--mantine-spacing-xs)")};
      padding: ${unsafeCSSValue("var(--mantine-spacing-2xs)")}
        ${unsafeCSSValue("var(--mantine-spacing-xs)")};
      height: ${unsafeCSSValue(
        "calc(var(--mantine-spacing-xl) + var(--mantine-spacing-xs) + var(--mantine-spacing-2xs))",
      )};
    }

    .lang-button:hover {
      background: ${unsafeCSSVar("hoverColor")};
    }

    .lang-button[hover] {
      background: ${unsafeCSSVar("hoverColor")};
    }

    .lang-button-icon {
      display: flex;
      align-items: center;
      color: ${unsafeCSSVar("iconColor")};

      svg {
        height: ${unsafeCSSValue("var(--mantine-spacing-lg)")};
        width: ${unsafeCSSValue("var(--mantine-spacing-lg)")};
      }
    }
  `;

  private _abortController?: AbortController;

  private readonly _clickLangBtn = () => {
    if (this.blockComponent.store.readonly) return;
    if (this._abortController) {
      // Close the language list if it's already opened.
      this._abortController.abort();
      return;
    }
    this._abortController = new AbortController();
    this._abortController.signal.addEventListener("abort", () => {
      this.onActiveStatusChange(false);
      this._abortController = undefined;
    });
    this.onActiveStatusChange(true);

    const options: FilterableListOptions = {
      placeholder: editorMessage(
        "com.myoxus.editor.code.search-language",
        "Search for a language",
      ),
      i18n:
        this.blockComponent.std.getOptional(EditorI18nProvider) ?? undefined,
      onSelect: (item) => {
        const sortedBundledLanguages = this._sortedBundledLanguages;
        const index = sortedBundledLanguages.indexOf(item);
        if (index !== -1) {
          sortedBundledLanguages.splice(index, 1);
          sortedBundledLanguages.unshift(item);
        }
        this.blockComponent.store.transact(() => {
          this.blockComponent.model.props.language$.value = item.name;
        });

        const std = this.blockComponent.std;
        const mode =
          std.getOptional(DocModeProvider)?.getEditorMode() ?? "page";
        const telemetryService = std.getOptional(TelemetryProvider);
        if (!telemetryService) return;
        telemetryService.track("codeBlockLanguageSelect", {
          page: mode,
          segment: "code block",
          module: "language selector",
          control: item.name,
        });
      },
      active: (item) => item.name === this.blockComponent.model.props.language,
      items: this._sortedBundledLanguages,
    };

    showPopFilterableList({
      options,
      referenceElement: this._langButton,
      container: this.blockComponent.host,
      abortController: this._abortController,
      // stacking-context(editor-host)
      portalStyles: {
        zIndex: "var(--myoxus-z-index-popover)",
      },
    });
  };

  private _sortedBundledLanguages: FilterableListItem[] = [];

  override connectedCallback(): void {
    super.connectedCallback();

    const langList = localStorage.getItem("virgultum:code-block:lang-list");
    if (langList) {
      this._sortedBundledLanguages = JSON.parse(langList);
    } else {
      this._sortedBundledLanguages = this.blockComponent.langs.map((lang) => ({
        label: lang.name,
        name: lang.id,
        aliases: lang.aliases,
      }));
    }

    this.disposables.add(() => {
      localStorage.setItem(
        "virgultum:code-block:lang-list",
        JSON.stringify(this._sortedBundledLanguages),
      );
    });
  }

  override render() {
    const textStyles = styleMap({
      fontFamily:
        "var(--mantine-font-family-body-small, var(--mantine-font-family))",
      fontSize:
        "var(--mantine-font-size-body-small, var(--mantine-font-size-md))",
      fontStyle: "normal",
      fontWeight:
        "var(--mantine-font-weight-body-small, var(--mantine-font-weight-regular))",
      lineHeight:
        "var(--mantine-line-height-body-small, var(--mantine-line-height-md))",
      padding: "0 var(--mantine-spacing-xs)",
    });

    return html`<icon-button
      class="lang-button"
      data-testid="lang-button"
      width="auto"
      .text=${html`<div style=${textStyles}>
        ${this.blockComponent.languageName$.value}
      </div>`}
      height="var(--mantine-spacing-xl)"
      @click=${this._clickLangBtn}
      ?disabled=${this.blockComponent.store.readonly}
    >
      <span class="lang-button-icon" slot="suffix">
        ${!this.blockComponent.store.readonly ? ArrowDownIcon : nothing}
      </span>
    </icon-button> `;
  }

  @query(".lang-button")
  private accessor _langButton!: HTMLElement;

  @property({ attribute: false })
  accessor blockComponent!: CodeBlockComponent;

  @property({ attribute: false })
  accessor onActiveStatusChange: (active: boolean) => void = noop;
}
