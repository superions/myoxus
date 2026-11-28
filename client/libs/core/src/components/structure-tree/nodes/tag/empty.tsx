// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { MyoxusDNDData } from "@myoxus/core/types/dnd";
import { useI18n } from "@myoxus/i18n";
import { type DropTargetDropEvent, useDropTarget } from "@myoxus/ui-facade";

import { EmptyNodeChildren } from "../../layouts/empty-node-children";

export function Empty({
  onDrop,
}: {
  onDrop: (data: DropTargetDropEvent<MyoxusDNDData>) => void;
}) {
  const { dropTargetRef } = useDropTarget(() => ({ onDrop }), [onDrop]);
  const t = useI18n();

  return (
    <EmptyNodeChildren ref={dropTargetRef}>
      {t["com.myoxus.rootAppSidebar.tags.no-doc"]()}
    </EmptyNodeChildren>
  );
}
