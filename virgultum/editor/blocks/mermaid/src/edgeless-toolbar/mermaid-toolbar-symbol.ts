// SPDX-License-Identifier: AGPL-3.0-or-later
import { svg } from "lit";

/** Toolbar artwork uses the existing senior-tool canvas, not a second UI shell. */
export function mermaidToolbarSymbol() {
  return svg`<svg width="64" height="64" viewBox="0 0 64 64" aria-hidden="true"
    fill="var(--myoxus-background-primary-color)"
    stroke="var(--myoxus-icon-color)" stroke-width="1.5" stroke-linejoin="round">
    <rect x="26" y="5" width="30" height="39" rx="4" />
    <path d="M32 12h18M32 17h12M32 22h18" fill="none" />
    <rect x="6" y="13" width="30" height="40" rx="4" />
    <g stroke="var(--myoxus-primary-color)">
      <path d="M21 25v5m-9 0h18m-18 0v5m18-5v5" fill="none" />
      <rect x="16" y="19" width="10" height="6" rx="1" />
      <rect x="9" y="35" width="7" height="6" rx="1" />
      <rect x="26" y="35" width="7" height="6" rx="1" />
    </g>
    <rect x="25" y="30" width="33" height="27" rx="4" />
    <g stroke="var(--myoxus-primary-color)">
      <path d="M36 43c4 0 4-6 9-6m-9 6h9m-9 0c4 0 4 7 9 7" fill="none" />
      <circle cx="33" cy="43" r="3" />
      <path d="M45 35h8v4h-8zM45 41h8v4h-8zM45 48h8v4h-8z" />
    </g>
  </svg>`;
}
