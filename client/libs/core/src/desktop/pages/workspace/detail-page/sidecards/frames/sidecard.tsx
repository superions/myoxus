// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ViewContextSurface } from "@myoxus/core/modules/workbench";
import { useI18n } from "@myoxus/i18n";
import { FrameIcon } from "@myoxus/icons/react";
import { DetailPageContextScrollRoot, Scrollable } from "@myoxus/ui-facade";
import type { EditorHost } from "@virgultum/editor/std";

import { EditorFramePanel } from "./panel";

const DOCUMENT_EDGELESS_VIEW_FAMILY = ["document-edgeless"] as const;

export function FramesSidecard({
  editor,
  isJournal,
  mode,
}: {
  editor: EditorHost | null;
  isJournal: boolean;
  mode: "page" | "edgeless";
}) {
  const t = useI18n();

  if (isJournal || mode !== "edgeless") {
    return null;
  }

  return (
    <ViewContextSurface
      surfaceId="frame"
      order={10}
      label={t["com.myoxus.sidebar.tab.frames"]()}
      tooltip={t["com.myoxus.sidebar.tab.frames.tooltip"]()}
      icon={<FrameIcon />}
      viewFamilies={DOCUMENT_EDGELESS_VIEW_FAMILY}
    >
      <DetailPageContextScrollRoot>
        <Scrollable.Viewport>
          <EditorFramePanel editor={editor} />
        </Scrollable.Viewport>
        <Scrollable.Scrollbar />
      </DetailPageContextScrollRoot>
    </ViewContextSurface>
  );
}
