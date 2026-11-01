import type { MyoxusDNDData } from "@myoxus/core/types/dnd";
import { useI18n } from "@myoxus/i18n";
import { FolderIcon, FolderOpenIcon } from "@myoxus/icons/react";
import {
  type DropTargetDropEvent,
  Skeleton,
  useDropTarget,
} from "@myoxus/ui-facade";

import { StructureTreeEmptySection } from "../../layouts/empty-section";
import { DropEffect } from "../../tree";
import { organizeEmptyDropEffect, organizeEmptyRootCanDrop } from "./dnd";

interface RootEmptyProps {
  onClickCreate?: () => void;
  isLoading?: boolean;
  onDrop?: (data: DropTargetDropEvent<MyoxusDNDData>) => void;
}

export const RootEmptyLoading = () => {
  return <Skeleton />;
};

export const RootEmptyReady = ({
  onClickCreate,
  onDrop,
}: Omit<RootEmptyProps, "isLoading">) => {
  const t = useI18n();

  const { dropTargetRef, draggedOverDraggable, draggedOverPosition } =
    useDropTarget<MyoxusDNDData>(
      () => ({
        data: { at: "structure-tree:organize:root" },
        onDrop,
        canDrop: organizeEmptyRootCanDrop,
      }),
      [onDrop],
    );

  return (
    <StructureTreeEmptySection
      ref={dropTargetRef}
      icon={draggedOverDraggable ? <FolderOpenIcon /> : <FolderIcon />}
      message={t["com.myoxus.rootAppSidebar.organize.empty"]()}
      messageTestId="slider-bar-organize-empty-message"
      actionText={t[
        "com.myoxus.rootAppSidebar.organize.empty.new-folders-button"
      ]()}
      onActionClick={onClickCreate}
    >
      {draggedOverDraggable && (
        <DropEffect
          position={draggedOverPosition}
          dropEffect={organizeEmptyDropEffect({
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
