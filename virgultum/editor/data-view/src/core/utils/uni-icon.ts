import * as icons from "@myoxus/icons/lit";
import { ShadowlessElement } from "@virgultum/std";
import { css, html, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";

import { uniMap } from "./uni-component/operation.js";
import { createUniComponentFromWebComponent } from "./uni-component/uni-component.js";

export class MyoxusLitIcon extends ShadowlessElement {
  static override styles = css`
    myoxus-lit-icon {
      display: flex;
      align-items: center;
      justify-content: center;
    }

    myoxus-lit-icon svg {
      fill: var(--myoxus-icon-color);
    }
  `;

  protected override render(): unknown {
    const createIcon = icons[this.name] as () => TemplateResult;
    return html`${createIcon?.()}`;
  }

  @property({ attribute: false })
  accessor name!: keyof typeof icons;
}

const litIcon = createUniComponentFromWebComponent<{ name: string }>(
  MyoxusLitIcon,
);
export const createIcon = (name: keyof typeof icons) => {
  return uniMap(litIcon, () => ({ name }));
};
