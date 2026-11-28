// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { ReactNode } from "react";

/**
 * Action descriptor rendered on a structure-tree node either inline next to the
 * row label or inside the node's overflow/context menu.
 */
export type NodeOperation = {
  index: number;
  view: ReactNode;
  inline?: boolean;
  alwaysVisible?: boolean;
};
