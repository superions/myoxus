import {
  type NodeOperation,
  StructureTreeContext,
} from "@myoxus/core/components/structure-tree";
import { StructureTreeRoot as StructureTreeRootFrame } from "@myoxus/ui-facade";
import { useMemo, useState } from "react";

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
    <StructureTreeRootFrame data-myoxus-ui-role="mobile-structure-tree">
      {childCount === 0 ? placeholder : null}
      <StructureTreeContext.Provider value={contextValue}>
        {children}
      </StructureTreeContext.Provider>
    </StructureTreeRootFrame>
  );
};
