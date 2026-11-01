import {
  type ButtonProps,
  type MenuSubProps,
  type RowInputProps,
} from "@myoxus/ui-facade";
import type { PropsWithChildren, ReactNode } from "react";

export interface RenameBaseProps {
  initialName?: string;
  onConfirm?: (name: string) => void;
}

export interface RenameContentProps extends RenameBaseProps {
  inputProps?: Omit<
    RowInputProps,
    | "className"
    | "inputClassName"
    | "inputStyle"
    | "onChange"
    | "style"
    | "value"
  >;
  confirmButtonProps?: Omit<
    ButtonProps,
    | "children"
    | "className"
    | "contentClassName"
    | "contentStyle"
    | "onClick"
    | "style"
  >;
  confirmText?: string;
  inputPrefixRenderer?: (props: { input: string }) => ReactNode;
  descRenderer?: (props: { input: string }) => ReactNode;
  inputBelowRenderer?: (props: { input: string }) => ReactNode;
}

export interface RenameSubMenuProps extends PropsWithChildren<RenameContentProps> {
  /** Submenu's title */
  title?: string;
  /** MenuItem.icon */
  icon?: ReactNode;
  /** MenuItem.text */
  text?: string;
  menuProps?: Partial<MenuSubProps>;
  disabled?: boolean;
}

export interface RenameDialogProps extends PropsWithChildren<RenameContentProps> {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  title?: string;
}
