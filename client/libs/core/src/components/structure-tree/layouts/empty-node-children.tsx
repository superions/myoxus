// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { StructureTreeEmptyChild } from "@myoxus/ui-facade";
import { forwardRef, type HTMLAttributes, type Ref } from "react";

export interface EmptyNodeChildrenProps extends HTMLAttributes<HTMLDivElement> {
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
