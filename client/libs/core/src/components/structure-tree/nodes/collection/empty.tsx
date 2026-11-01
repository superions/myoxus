import type { MyoxusDNDData } from "@myoxus/core/types/dnd";
import { useI18n } from "@myoxus/i18n";
import { type DropTargetDropEvent, useDropTarget } from "@myoxus/ui-facade";

import { EmptyNodeChildren } from "../../layouts/empty-node-children";

export const Empty = ({
  onDrop,
}: {
  onDrop: (data: DropTargetDropEvent<MyoxusDNDData>) => void;
}) => {
  const { dropTargetRef } = useDropTarget(
    () => ({
      onDrop,
    }),
    [onDrop],
  );
  const t = useI18n();
  return (
    <EmptyNodeChildren ref={dropTargetRef}>
      {t["com.myoxus.collection.emptyCollection"]()}
    </EmptyNodeChildren>
  );
};
