// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import {
  type CSSProperties,
  type ReactNode,
  isValidElement,
  cloneElement,
} from "react";

const menuInlineIconSvgStyle: CSSProperties = {
  width: "100%",
  height: "100%",
};

export function menuIconContent(icon: ReactNode): ReactNode {
  if (!isValidElement<{ style?: CSSProperties }>(icon)) return icon;
  return cloneElement(icon, {
    style: {
      ...menuInlineIconSvgStyle,
      ...icon.props.style,
    },
  });
}
