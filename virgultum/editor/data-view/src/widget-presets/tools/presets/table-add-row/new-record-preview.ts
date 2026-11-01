import { PlusIcon } from "@myoxus/icons/lit";
import { cssVar } from "@myoxus/theme";
import { ShadowlessElement } from "@virgultum/std";
import { html, unsafeCSS } from "lit";

export class NewRecordPreview extends ShadowlessElement {
  override render() {
    return html`
      <style>
        myoxus-database-new-record-preview {
          display: flex;
          align-items: center;
          justify-content: center;
          position: fixed;
          top: 0;
          left: 0;
          height: 32px;
          width: 32px;
          border: 1px solid ${unsafeCSS(cssVar("borderColor"))};
          border-radius: 50%;
          background: var(--myoxus-blue-100);
          box-shadow:
            0px 0px 10px rgba(0, 0, 0, 0.05),
            0px 0px 0px 0.5px var(--myoxus-black-10);
          cursor: none;
          user-select: none;
          pointer-events: none;
          caret-color: transparent;
          z-index: 99999;
        }

        myoxus-database-new-record-preview svg {
          width: 16px;
          height: 16px;
        }

        myoxus-database-new-record-preview path {
          fill: var(--myoxus-brand-color);
        }
      </style>
      ${PlusIcon()}
    `;
  }
}
