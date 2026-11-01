// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ContextDocumentTargetInput } from "@myoxus/graphql";
import {
  createContext,
  useContext,
  type ReactNode,
  type RefObject,
} from "react";

export type ContextDocumentMenuTarget = ContextDocumentTargetInput & {
  title: string;
  projectId?: string;
  opener?: HTMLElement | null;
  returnFocusRef?: RefObject<HTMLElement | null>;
};
export type ContextDocumentMenu = (
  target?: ContextDocumentMenuTarget,
) => ReactNode;
export const ContextDocumentAssistanceContext = createContext<{
  menu: ContextDocumentMenu;
  available: boolean;
  openMaintenanceRun?: (runId: string, opener?: HTMLElement | null) => void;
}>({ menu: () => null, available: false });
/** Row detail consumes the host's existing controller; embedded/standalone
 * details without that host do not create another controller or Context Card. */
export const useContextDocumentMenu = () =>
  useContext(ContextDocumentAssistanceContext).menu;
export const useOpenMaintenanceRun = () =>
  useContext(ContextDocumentAssistanceContext).openMaintenanceRun;
