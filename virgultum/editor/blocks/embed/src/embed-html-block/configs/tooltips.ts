// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Myoxus

import { getArtworkUrl } from "@myoxus/theme/artwork";
import { html } from "lit";

export const TweetTooltip = html`<img
  src=${getArtworkUrl("tooltip-iframe")}
  width="170"
  height="106"
  alt=""
/>`;

export const LinearTooltip = html`<img
  src=${getArtworkUrl("tooltip-iframe")}
  width="170"
  height="106"
  alt=""
/>`;
