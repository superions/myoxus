// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { createContext, useContext, type ReactNode } from "react";

export interface ArtifactPreviewPayload {
  title: string;
  icon: ReactNode;
  content: ReactNode;
  controls?: ReactNode;
}

export interface ChatPreviewController {
  openPreview: (ownerId: string, data: ArtifactPreviewPayload) => void;
  closePreview: (ownerId: string) => void;
  isOwnerOpen: (ownerId: string) => boolean;
}

export const ChatPreviewContext = createContext<ChatPreviewController | null>(
  null,
);

export function useChatPreview() {
  return useContext(ChatPreviewContext);
}
