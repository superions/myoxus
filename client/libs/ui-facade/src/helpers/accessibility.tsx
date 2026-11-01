// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import {
  Children,
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";

export function reactNodeText(node: ReactNode): string | undefined {
  if (typeof node === "string" || typeof node === "number") {
    const text = String(node).trim();
    return text.length > 0 ? text : undefined;
  }
  if (Array.isArray(node)) {
    return node.map(reactNodeText).filter(Boolean).join(" ") || undefined;
  }
  if (isValidElement(node)) {
    return reactNodeText((node.props as { children?: ReactNode }).children);
  }
  return undefined;
}

export function withImplicitControlName(
  children: ReactNode,
  label: ReactNode,
): ReactNode {
  const name = reactNodeText(label);
  if (!name) return children;

  return Children.map(children, (child) => {
    if (!isValidElement(child)) return child;
    const props = child.props as Record<string, unknown>;
    if (
      props["aria-label"] !== undefined ||
      props["aria-labelledby"] !== undefined ||
      props.label !== undefined
    ) {
      return child;
    }
    return cloneElement(child as ReactElement<Record<string, unknown>>, {
      "aria-label": name,
    });
  });
}
