import {
  getBlockSelectionsCommand,
  getTextSelectionCommand,
} from "@virgultum/shared/commands";
import type {
  MyoxusTextAttributes,
  MyoxusTextStyleAttributes,
} from "@virgultum/shared/types";
import type { Command } from "@virgultum/std";

import { formatBlockCommand } from "./format-block.js";
import { formatNativeCommand } from "./format-native.js";
import { formatTextCommand } from "./format-text.js";
import {
  getCombinedTextAttributes,
  getCombinedTextAttributeState,
  type TextAttributeState,
} from "./utils.js";

export const toggleTextStyleCommand: Command<{
  key: Extract<
    keyof MyoxusTextStyleAttributes,
    "bold" | "italic" | "underline" | "strike" | "code"
  >;
}> = (ctx, next) => {
  const { std, key } = ctx;
  const [active] = std.command
    .chain()
    .pipe(isTextAttributeActive, { key })
    .run();

  const payload: {
    styles: MyoxusTextStyleAttributes;
    mode?: "replace" | "merge";
  } = {
    styles: {
      [key]: active ? null : true,
    },
  };

  const [result] = std.command
    .chain()
    .try((chain) => [
      chain.pipe(getTextSelectionCommand).pipe(formatTextCommand, payload),
      chain.pipe(getBlockSelectionsCommand).pipe(formatBlockCommand, payload),
      chain.pipe(formatNativeCommand, payload),
    ])
    .run();

  if (result) {
    return next();
  }

  return false;
};

const toggleTextStyleCommandWrapper = (
  key: Extract<
    keyof MyoxusTextStyleAttributes,
    "bold" | "italic" | "underline" | "strike" | "code"
  >,
): Command => {
  return (ctx, next) => {
    const [success] = ctx.std.command
      .chain()
      .pipe(toggleTextStyleCommand, { key })
      .run();
    if (success) next();
    return false;
  };
};

export const toggleBold = toggleTextStyleCommandWrapper("bold");
export const toggleItalic = toggleTextStyleCommandWrapper("italic");
export const toggleUnderline = toggleTextStyleCommandWrapper("underline");
export const toggleStrike = toggleTextStyleCommandWrapper("strike");
export const toggleCode = toggleTextStyleCommandWrapper("code");

export const getTextAttributes: Command<
  {},
  { textAttributes: MyoxusTextAttributes }
> = (ctx, next) => {
  const [result, innerCtx] = getCombinedTextAttributes(
    ctx.std.command.chain(),
  ).run();
  if (!result) {
    return false;
  }

  return next({ textAttributes: innerCtx.textAttributes });
};

export const getTextAttributeState: Command<
  { key: keyof MyoxusTextAttributes },
  { textAttributeState: TextAttributeState<keyof MyoxusTextAttributes> }
> = (ctx, next) => {
  const [result, innerCtx] = getCombinedTextAttributeState(
    ctx.std.command.chain(),
    ctx.key,
  ).run();
  if (!result || !innerCtx.textAttributeState) return false;

  return next({ textAttributeState: innerCtx.textAttributeState });
};

export const isTextAttributeActive: Command<{
  key: keyof MyoxusTextAttributes;
}> = (ctx, next) => {
  const key = ctx.key;
  const [result] = getCombinedTextAttributes(ctx.std.command.chain())
    .pipe((ctx, next) => {
      const { textAttributes } = ctx;

      if (textAttributes && key in textAttributes) {
        return next();
      }

      return false;
    })
    .run();

  if (!result) {
    return false;
  }

  return next();
};
