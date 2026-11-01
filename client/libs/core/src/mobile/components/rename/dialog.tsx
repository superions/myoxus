import { Modal } from "@myoxus/ui-facade";
import { useCallback } from "react";

import { RenameContent } from "./content";
import type { RenameDialogProps } from "./type";

export const RenameDialog = ({
  open,
  title,
  onOpenChange,
  onConfirm,
  children,
  ...props
}: RenameDialogProps & {
  open?: boolean;
  onOpenChange?: (v: boolean) => void;
}) => {
  const handleRename = useCallback(
    (value: string) => {
      onConfirm?.(value);
      onOpenChange?.(false);
    },
    [onOpenChange, onConfirm],
  );

  return (
    <Modal
      width="100%"
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      contentOptions={{ bodyPadding: "none" }}
    >
      {children ?? <RenameContent onConfirm={handleRename} {...props} />}
    </Modal>
  );
};
