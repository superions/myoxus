// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2022-2026 TOEVERYTHING PTE. LTD. and its affiliates.
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import { css, html, nothing } from "lit";

/** Authored caption fallback for readonly renderers without a React chrome host. */
export function renderReadonlyCaption(caption: string | null | undefined) {
  if (!caption) return nothing;
  return html`<figcaption class="block-caption-static">${caption}</figcaption>`;
}

export const captionStyles = css`
  .block-caption-static {
    color: var(--myoxus-icon-color);
    font-size: var(--myoxus-font-sm);
    text-align: center;
    white-space: pre-wrap;
    margin-top: 4px;
  }
`;
