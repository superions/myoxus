import type { MyoxusDNDData } from "@myoxus/core/types/dnd";
import { useI18n } from "@myoxus/i18n";
import { FavoriteIcon } from "@myoxus/icons/react";
import {
  type DropTargetDropEvent,
  Skeleton,
  useDropTarget,
} from "@myoxus/ui-facade";

import { StructureTreeEmptySection } from "../../layouts/empty-section";
import { DropEffect } from "../../tree";
import { favoriteRootCanDrop, favoriteRootDropEffect } from "./dnd";

interface RootEmptyProps {
  onDrop?: (data: DropTargetDropEvent<MyoxusDNDData>) => void;
  isLoading?: boolean;
}

const RootEmptyLoading = () => {
  return <Skeleton />;
};
const RootEmptyReady = ({ onDrop }: Omit<RootEmptyProps, "isLoading">) => {
  const t = useI18n();

  const { dropTargetRef, draggedOverDraggable, draggedOverPosition } =
    useDropTarget<MyoxusDNDData>(
      () => ({
        data: {
          at: "structure-tree:favorite:root",
        },
        onDrop: onDrop,
        canDrop: favoriteRootCanDrop,
        allowExternal: true,
      }),
      [onDrop],
    );

  return (
    <StructureTreeEmptySection
      ref={dropTargetRef}
      icon={FavoriteIcon}
      message={t["com.myoxus.rootAppSidebar.favorites.empty"]()}
      messageTestId="slider-bar-favorites-empty-message"
    >
      {draggedOverDraggable && (
        <DropEffect
          position={draggedOverPosition}
          dropEffect={favoriteRootDropEffect({
            source: draggedOverDraggable,
            treeInstruction: null,
          })}
        />
      )}
    </StructureTreeEmptySection>
  );
};

export const RootEmpty = ({ isLoading, ...props }: RootEmptyProps) => {
  return isLoading ? <RootEmptyLoading /> : <RootEmptyReady {...props} />;
};
