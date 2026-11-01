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
  dropEffect?: "copy" | "move" | "link" | undefined;
  position: ReturnType<typeof useDropTarget>["draggedOverPosition"];
}) => {
  const t = useI18n();
  if (dropEffect === undefined) return null;
  return createPortal(
    <StructureTreeDropEffect
      style={{
        // DnD reports viewport pointer coordinates in CSS pixels. Keep the
        // pointer transform as geometry data while the visual chrome stays in
        // the shared StructureTree facade.
        transform: `translate(${position.clientX}px, ${position.clientY}px)`,
      }}
    >
      <StructureTreeDropEffectIcon>
        {dropEffect === "copy" ? (
          <CopyIcon />
        ) : dropEffect === "move" ? (
          <MoveToIcon />
        ) : (
          <LinkIcon />
        )}
      </StructureTreeDropEffectIcon>
      {dropEffect === "copy"
        ? t["com.myoxus.rootAppSidebar.explorer.drop-effect.copy"]()
        : dropEffect === "move"
          ? t["com.myoxus.rootAppSidebar.explorer.drop-effect.move"]()
          : t["com.myoxus.rootAppSidebar.explorer.drop-effect.link"]()}
    </StructureTreeDropEffect>,
    document.body,
  );
};
