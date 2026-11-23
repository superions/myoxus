// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { createIdentifier } from "@virgultum/core/primitives/di";
import type { FrameBlockModel } from "@virgultum/core/models";
import type { BlockStdScope } from "@virgultum/core/runtime";

import { MYOXUS_FRAME_TITLE } from "./frame-title";
import type { MyoxusFrameTitle } from "./native-frame-title";

export const FrameTitleIdentifier = createIdentifier<boolean>("FrameTitle");

export function mountFrameTitle(
  anchor: HTMLElement,
  model: FrameBlockModel,
  std: BlockStdScope,
) {
  const title = anchor.ownerDocument.createElement(
    MYOXUS_FRAME_TITLE,
  ) as MyoxusFrameTitle;
  title.model = model;
  title.std = std;
  title.dataset.id = model.id;
  // Preserve the title border outside the measured content height.
  title.style.boxSizing = "content-box";
  anchor.append(title);
  return title;
}
