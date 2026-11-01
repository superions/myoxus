// SPDX-License-Identifier: AGPL-3.0-or-later

import { Box, ScrollArea, type ScrollAreaProps } from "@mantine/core";
import {
  type PropsWithChildren,
  type Ref,
  useLayoutEffect,
  useRef,
} from "react";

type PrimaryScrollAreaProps = PropsWithChildren<
  ScrollAreaProps & {
    readonly "data-myoxus-ui-role"?: string;
    readonly owner?: "parent" | "self";
    readonly autosize?: boolean;
    readonly viewportRef?: Ref<HTMLDivElement>;
  }
>;

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}

function nearestScrollableAncestor(element: HTMLElement) {
  let current = element.parentElement;
  while (current) {
    // Mantine mounts its viewport before overflow measurement enables the scrollbars.
    // Bind the declared owner now; a temporary hidden overflow must not select an outer document.
    if (current.classList.contains("mantine-ScrollArea-viewport"))
      return current;
    const style = getComputedStyle(current);
    if (/(auto|scroll)/.test(`${style.overflowX} ${style.overflowY}`)) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

/**
 * Product-neutral primary-workarea ownership switch. Parent ownership keeps a
 * measuring wrapper but delegates all scrolling to the nearest real ancestor
 * viewport, so keyboard/drag helpers and ResizeObserver consumers retain one
 * authoritative element without creating a nested scroll path.
 */
export function PrimaryScrollArea({
  children,
  "data-myoxus-ui-role": uiRole,
  owner = "self",
  autosize = false,
  viewportRef,
  ...props
}: PrimaryScrollAreaProps) {
  const parentContentRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (owner !== "parent" || !parentContentRef.current) return;
    assignRef(viewportRef, nearestScrollableAncestor(parentContentRef.current));
    return () => assignRef(viewportRef, null);
  }, [owner, viewportRef]);

  if (owner === "parent") {
    return (
      <Box data-myoxus-ui-role={uiRole} ref={parentContentRef}>
        {children}
      </Box>
    );
  }

  const Component = autosize ? ScrollArea.Autosize : ScrollArea;
  return (
    <Component
      {...props}
      data-myoxus-ui-role={uiRole}
      viewportRef={viewportRef}
    >
      {children}
    </Component>
  );
}
