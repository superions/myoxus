// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import {
  type CSSProperties,
  type HTMLAttributes,
  type PropsWithChildren,
} from "react";

/** Shared DOM contract for lightweight semantic Facade roles. */
export type RoleBoxProps = PropsWithChildren<{
  id?: string;
  className?: string;
  dir?: HTMLAttributes<HTMLElement>["dir"];
  style?: CSSProperties;
  "data-testid"?: string;
  "data-myoxus-ui-role"?: string;
  "aria-label"?: string;
  "aria-live"?: HTMLAttributes<HTMLElement>["aria-live"];
  onClick?: HTMLAttributes<HTMLElement>["onClick"];
  onKeyDown?: HTMLAttributes<HTMLElement>["onKeyDown"];
  onMouseDown?: HTMLAttributes<HTMLElement>["onMouseDown"];
  onPointerDown?: HTMLAttributes<HTMLElement>["onPointerDown"];
  role?: HTMLAttributes<HTMLElement>["role"];
  tabIndex?: HTMLAttributes<HTMLElement>["tabIndex"];
  [key: `data-${string}`]: unknown;
}>;

export type TextOverflowRoleProps = {
  truncate?: boolean;
  lineClamp?: number;
};

export function textOverflowRole({
  truncate,
  lineClamp,
}: TextOverflowRoleProps): CSSProperties {
  if (lineClamp) {
    return {
      display: "-webkit-box",
      WebkitBoxOrient: "vertical",
      WebkitLineClamp: lineClamp,
      overflow: "hidden",
    };
  }
  if (!truncate) return {};
  return {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  };
}

export type MyoxusUiRoleProp = {
  "data-myoxus-ui-role"?: string;
};

export type FlexWrapperComponent =
  | "article"
  | "aside"
  | "div"
  | "footer"
  | "header"
  | "main"
  | "nav"
  | "section"
  | "span";
