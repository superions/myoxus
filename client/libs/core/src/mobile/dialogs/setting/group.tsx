import { ConfigModal } from "@myoxus/core/components/mobile";
import { forwardRef, type HTMLProps, type ReactNode } from "react";

export interface SettingGroupProps extends Omit<
  HTMLProps<HTMLDivElement>,
  "title"
> {
  title?: ReactNode;
}

export const SettingGroup = forwardRef<HTMLDivElement, SettingGroupProps>(
  function SettingGroup({ children, title, className, ...attrs }, ref) {
    return (
      <ConfigModal.RowGroup
        {...attrs}
        ref={ref}
        title={title}
        className={className}
      >
        {children}
      </ConfigModal.RowGroup>
    );
  },
);
