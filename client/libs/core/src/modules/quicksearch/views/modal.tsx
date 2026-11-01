import { CommandPaletteModal } from "@myoxus/ui-facade";
import type { PropsWithChildren } from "react";

// a QuickSearch modal that can be used to display a QuickSearch command
// it has a smooth animation and can be closed by clicking outside of the modal

export interface QuickSearchModalProps {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
}

export const QuickSearchModal = ({
  onOpenChange,
  open,
  children,
}: PropsWithChildren<QuickSearchModalProps>) => {
  return (
    <CommandPaletteModal
      ariaLabel="Quick search"
      open={open}
      onOpenChange={onOpenChange}
    >
      {children}
    </CommandPaletteModal>
  );
};
