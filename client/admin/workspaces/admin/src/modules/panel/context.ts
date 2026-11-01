// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useContext,
} from "react";

export interface AdminDetailPanelController {
  isOpen: boolean;
  panelContent: ReactNode;
  setPanelContent: (content: ReactNode) => void;
  openPanel: () => void;
  closePanel: () => void;
  togglePanel: () => void;
  hasDirtyChanges: boolean;
  setHasDirtyChanges: Dispatch<SetStateAction<boolean>>;
}

export const AdminDetailPanelContext =
  createContext<AdminDetailPanelController | null>(null);

export function useRightPanel() {
  const controller = useContext(AdminDetailPanelContext);
  if (!controller) {
    throw new Error(
      "Admin detail panel is unavailable outside the Admin shell",
    );
  }
  return controller;
}
