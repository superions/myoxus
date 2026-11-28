// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { StructureTreeRoot as StructureTreeRootFrame } from "@myoxus/ui-facade";
import { type ComponentProps, type ReactNode, useMemo, useState } from "react";

import { StructureTreeContext } from "./context";
import type { NodeOperation } from "./types";

export const StructureTreeRoot = ({
  children,
  childrenOperations = [],
  density,
  placeholder,
}: {
  children?: ReactNode;
  childrenOperations?: NodeOperation[];
  className?: string;
  density?: ComponentProps<typeof StructureTreeRootFrame>["density"];
  placeholder?: ReactNode;
}) => {
  const [childCount, setChildCount] = useState(0);

  const contextValue = useMemo(
    () => ({
      operations: childrenOperations,
      level: 0,
      registerChild: () => {
        setChildCount((count) => count + 1);
        return () => setChildCount((count) => count - 1);
      },
    }),
    [childrenOperations],
  );

  return (
    <StructureTreeRootFrame density={density}>
      {childCount === 0 ? placeholder : null}
      <StructureTreeContext.Provider value={contextValue}>
        {children}
      </StructureTreeContext.Provider>
    </StructureTreeRootFrame>
  );
};
