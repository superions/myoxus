// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { nanoid } from "nanoid";
import { useCallback, useState, type ReactNode, type ReactPortal } from "react";
import ReactDOM from "react-dom";

export type EditorPortal = {
  id: string;
  portal: ReactPortal;
  target: HTMLElement;
};

/** Mounts in the current React provider tree. The caller owns anchor lifetime. */
export type MountReactPortal = (
  target: HTMLElement,
  element: ReactNode,
) => () => void;

export const usePortalFactory = () => {
  const [portals, setPortals] = useState<EditorPortal[]>([]);
  const mountPortal = useCallback<MountReactPortal>((target, element) => {
    const id = nanoid();
    const entry: EditorPortal = {
      id,
      target,
      portal: ReactDOM.createPortal(element, target),
    };
    setPortals((current) => [...current, entry]);
    return () => setPortals((current) => current.filter((p) => p !== entry));
  }, []);

  return [portals, mountPortal] as const;
};
