/**
 * `StructureTreeRoot` — container component that bootstraps the tree
 * context at level 0.
 *
 * Responsibilities:
 * - Creates the `StructureTreeContext` value (starting level + operations)
 *   and provides it to all descendant tree nodes.
 * - Tracks the number of registered children via `childCount`.  When the count
 *   drops to zero a `placeholder` slot is rendered instead.  This allows
 *   sections to show an empty-state element without conditional rendering at
 *   every call site.
 *
 * @param children           - Tree nodes to render inside the root context.
 * @param childrenOperations - Operations (context-menu actions, drag handlers)
 *                             available on all direct children of this root.
 * @param placeholder        - Element shown when there are no children.
 */
import { StructureTreeRoot as StructureTreeRootFrame } from "@myoxus/ui-facade";
import { useMemo, useState } from "react";

import { StructureTreeContext } from "./context";
import type { NodeOperation } from "./types";

export const StructureTreeRoot = ({
  children,
  childrenOperations = [],
  placeholder,
}: {
  children?: React.ReactNode;
  childrenOperations?: NodeOperation[];
  className?: string;
  placeholder?: React.ReactNode;
}) => {
  const [childCount, setChildCount] = useState(0);
  const contextValue = useMemo(() => {
    return {
      operations: childrenOperations,
      level: 0,
      registerChild: () => {
        setChildCount((c) => c + 1);
        return () => setChildCount((c) => c - 1);
      },
    };
  }, [childrenOperations]);

  return (
    <StructureTreeRootFrame>
      {childCount === 0 ? placeholder : null}
      <StructureTreeContext.Provider value={contextValue}>
        {children}
      </StructureTreeContext.Provider>
    </StructureTreeRootFrame>
  );
};
