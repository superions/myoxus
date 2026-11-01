import type { MyoxusDNDData } from "@myoxus/core/types/dnd";
import { useI18n } from "@myoxus/i18n";
import { type DropTargetDropEvent, useDropTarget } from "@myoxus/ui-facade";

import { EmptyNodeChildren } from "../../layouts/empty-node-children";

export const Empty = ({
  onDrop,
  noAccessible = false,
}: {
  onDrop: (data: DropTargetDropEvent<MyoxusDNDData>) => void;
  noAccessible?: boolean;
}) => {
  const { dropTargetRef } = useDropTarget<MyoxusDNDData>(
    () => ({
      onDrop,
    }),
    [onDrop],
  );
  const t = useI18n();

  return (
    <EmptyNodeChildren ref={dropTargetRef}>
      {noAccessible
        ? t["com.myoxus.share-menu.option.permission.no-access"]()
        : t["com.myoxus.rootAppSidebar.docs.no-subdoc"]()}
    </EmptyNodeChildren>
  );
};
