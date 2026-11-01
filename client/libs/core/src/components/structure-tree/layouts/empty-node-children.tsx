import { StructureTreeEmptyChild } from "@myoxus/ui-facade";
import { forwardRef, type HTMLAttributes, type Ref } from "react";

interface EmptyNodeChildrenProps extends HTMLAttributes<HTMLDivElement> {
  dropTarget?: boolean;
}

export const EmptyNodeChildren = forwardRef(function EmptyNodeChildren(
  { children, className, dropTarget, ...attrs }: EmptyNodeChildrenProps,
  ref: Ref<HTMLDivElement>,
) {
  return (
    <StructureTreeEmptyChild
      className={className}
      dropTarget={dropTarget}
      ref={ref}
      {...attrs}
    >
      {children}
    </StructureTreeEmptyChild>
  );
});
