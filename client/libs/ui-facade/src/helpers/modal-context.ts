// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createContext, useContext } from "react";

export const InsideModalContext = createContext<string | undefined>(undefined);

/** The native modal root keeps select and color-picker portals outside its clipping scroll area. */
export function useModalPortalTarget() {
  return useContext(InsideModalContext);
}

export function useIsInsideModal() {
  return useModalPortalTarget() !== undefined;
}
