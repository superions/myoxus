import { WithDisposable } from "@virgultum/global/lit";
import { unsafeCSSVar } from "@virgultum/shared/theme";
import { ShadowlessElement } from "@virgultum/std";
import { css } from "lit";
import { property, query } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { styleMap } from "lit/directives/style-map.js";
import { html } from "lit/static-html.js";

import type { SelectTag } from "../../logical/index.js";
import { getColorByColor } from "./colors.js";

export class MultiTagView extends WithDisposable(ShadowlessElement) {
  static override styles = css`
    myoxus-multi-tag-view {
      display: flex;
      align-items: center;
      width: 100%;
      height: 100%;
      min-height: 22px;
    }

    .myoxus-select-cell-container * {
      box-sizing: border-box;
    }

    .myoxus-select-cell-container {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 6px;
      width: 100%;
      font-size: var(--myoxus-font-sm);
    }

    .myoxus-select-cell-container .select-selected {
      height: 22px;
      font-size: 14px;
      line-height: 20px;
      padding: 0 8px;
      border-radius: 4px;
      white-space: nowrap;
      background: var(--myoxus-tag-white);
      overflow: hidden;
      text-overflow: ellipsis;
      border: 1px solid ${unsafeCSSVar("borderColor")};
    }
  `;

  override render() {
    const values = this.value;
    const map = new Map<string, SelectTag>(this.options?.map((v) => [v.id, v]));
    return html`
      <div contenteditable="false" class="myoxus-select-cell-container">
        ${repeat(values, (id) => {
          const option = map.get(id);
          if (!option) {
            return;
          }
          const style = styleMap({
            backgroundColor: getColorByColor(option.color),
          });
          return html`<span
            data-testid="tag-selected"
            class="select-selected"
            style=${style}
            >${option.value}</span
          >`;
        })}
      </div>
    `;
  }

  @property({ attribute: false })
  accessor options: SelectTag[] = [];

  @query(".myoxus-select-cell-container")
  accessor selectContainer!: HTMLElement;

  @property({ attribute: false })
  accessor value: string[] = [];
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-multi-tag-view": MultiTagView;
  }
}
