// SPDX-License-Identifier: AGPL-3.0-or-later

import "./drag-handle.css";

import { GripVerticalIcon } from "@myoxus/icons/react";
import { forwardRef, type HTMLAttributes, type KeyboardEvent } from "react";

import { joinClassName } from "./css-utils";

export type DragHandleProps = HTMLAttributes<HTMLDivElement> & {
  dragging?: boolean;
  disabled?: boolean;
  /**
   * Keyboard handler for moved items. Receives a signed axis delta
   * (`-1` = previous, `+1` = next) for the configured arrow-key orientation.
   */
  onKeyboardMove?: (delta: -1 | 1) => void;
  keyboardMoveModifier?: "alt" | "none";
  keyboardMoveOrientation?: "horizontal" | "vertical";
  /**
   * Optional `onKeyDown` passthrough for consumers that want full control.
   * Fires after the built-in keyboard move handling.
   */
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
};

export const DragHandle = forwardRef<HTMLDivElement, DragHandleProps>(
  function DragHandle(
    {
      className,
      dragging,
      disabled,
      onKeyboardMove,
      keyboardMoveModifier = "none",
      keyboardMoveOrientation = "horizontal",
      onKeyDown,
      onClick,
      onPointerDown,
      ...props
    },
    ref,
  ) {
    const accessible = Boolean(
      props["aria-label"] || props["aria-labelledby"] || onKeyboardMove,
    );

    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
      if (disabled) return;
      const previousKey =
        keyboardMoveOrientation === "vertical" ? "ArrowUp" : "ArrowLeft";
      const nextKey =
        keyboardMoveOrientation === "vertical" ? "ArrowDown" : "ArrowRight";
      if (
        onKeyboardMove &&
        (event.key === previousKey || event.key === nextKey) &&
        (keyboardMoveModifier !== "alt" || event.altKey)
      ) {
        event.preventDefault();
        const delta: -1 | 1 = event.key === previousKey ? -1 : 1;
        onKeyboardMove(delta);
      }
      onKeyDown?.(event);
    };

    return (
      <div
        {...props}
        ref={ref}
        role={accessible ? "button" : undefined}
        tabIndex={accessible && !disabled ? 0 : undefined}
        aria-disabled={accessible ? disabled || undefined : undefined}
        data-dragging={dragging ? "true" : undefined}
        data-disabled={disabled ? "true" : undefined}
        className={joinClassName("myoxus-drag-handle", className)}
        onKeyDown={accessible ? handleKeyDown : onKeyDown}
        onClick={onClick}
        onPointerDown={onPointerDown}
      >
        <GripVerticalIcon aria-hidden className="myoxus-drag-handle__icon" />
      </div>
    );
  },
);
