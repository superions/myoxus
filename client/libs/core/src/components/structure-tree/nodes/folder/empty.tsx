import type { MyoxusDNDData } from "@myoxus/core/types/dnd";
import { useI18n } from "@myoxus/i18n";
import {
  type DropTargetDropEvent,
  type DropTargetOptions,
  useDropTarget,
} from "@myoxus/ui-facade";

import { EmptyNodeChildren } from "../../layouts/empty-node-children";

export const FolderEmpty = ({
  canDrop,
  onDrop,
}: {
  onDrop?: (data: DropTargetDropEvent<MyoxusDNDData>) => void;
  canDrop?: DropTargetOptions<MyoxusDNDData>["canDrop"];
}) => {
  const { dropTargetRef } = useDropTarget(
    () => ({
      onDrop,
      canDrop,
    }),
    [onDrop, canDrop],
  );

  const t = useI18n();
  return (
    <EmptyNodeChildren ref={dropTargetRef} dropTarget>
      {t["com.myoxus.rootAppSidebar.organize.empty-folder"]()}
    </EmptyNodeChildren>
  );
};
