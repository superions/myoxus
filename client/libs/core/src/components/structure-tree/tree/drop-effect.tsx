// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useI18n } from "@myoxus/i18n";
import { CopyIcon, LinkIcon, MoveToIcon } from "@myoxus/icons/react";
import {
  StructureTreeDropEffect,
  StructureTreeDropEffectIcon,
  type useDropTarget,
} from "@myoxus/ui-facade";
import { createPortal } from "react-dom";

export const DropEffect = ({
  dropEffect,
  position,
}: {
  dropEffect?: "copy" | "move" | "link";
  position: ReturnType<typeof useDropTarget>["draggedOverPosition"];
}) => {
  const t = useI18n();
  if (dropEffect === undefined) {
    return null;
  }

  const icon =
    dropEffect === "copy" ? (
      <CopyIcon />
    ) : dropEffect === "move" ? (
      <MoveToIcon />
    ) : (
      <LinkIcon />
    );

  const label =
    dropEffect === "copy"
      ? t["com.myoxus.rootAppSidebar.explorer.drop-effect.copy"]()
      : dropEffect === "move"
        ? t["com.myoxus.rootAppSidebar.explorer.drop-effect.move"]()
        : t["com.myoxus.rootAppSidebar.explorer.drop-effect.link"]();

  return createPortal(
    <StructureTreeDropEffect x={position.clientX} y={position.clientY}>
      <StructureTreeDropEffectIcon>{icon}</StructureTreeDropEffectIcon>
      {label}
    </StructureTreeDropEffect>,
    document.body,
  );
};
