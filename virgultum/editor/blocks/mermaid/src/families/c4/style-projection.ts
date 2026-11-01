// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidVisualNode } from "../runtime/gfx-model.js";
import { mermaidVisualFamilyPayload } from "../runtime/gfx-family-data.js";
import { projectMermaidSourceStyle } from "../runtime/source-style-projection.js";
import type { MermaidC4Model } from "../../engine/c4/model.js";
import {
  C4_CALLS,
  type MermaidC4Config,
} from "../../engine/c4/runtime-contract.js";

export function c4NativeSourceStyles(
  owner:
    MermaidC4Model["elements"][number] | MermaidC4Model["boundaries"][number],
  config: MermaidC4Config,
) {
  const fields = owner.resolution!.fields,
    type = C4_CALLS[owner.kind]?.nativeType;
  const string = (value: unknown) =>
    typeof value === "string" && value ? value : undefined;
  // An authored empty Update suppresses its config value in the native consumer.
  const fill = string(
    fields.bgColor ??
      (type ? config[`${type}_bg_color` as keyof typeof config] : undefined),
  );
  const stroke = string(
    fields.borderColor ??
      (type
        ? config[`${type}_border_color` as keyof typeof config]
        : undefined),
  );
  const color = string(fields.fontColor);
  return {
    ...(fill ? { fill } : {}),
    ...(stroke ? { stroke } : {}),
    ...(color ? { color } : {}),
    ...(C4_CALLS[owner.kind]?.category === "boundary"
      ? c4SourceFontStyles(config, "boundary")
      : {}),
  };
}

/** Only native boundary/message font consumers receive authored config fonts.
 * Unified element bodies do not consume the legacy per-element font fields. */
export function c4SourceFontStyles(
  config: MermaidC4Config,
  owner: "boundary" | "message",
) {
  const family =
    (owner === "message" ? config.fontFamily : undefined) ||
    config[`${owner}FontFamily`];
  const size =
    (owner === "message" ? config.fontSize : undefined) ||
    config[`${owner}FontSize`];
  const weight =
    (owner === "message" ? config.fontWeight : undefined) ||
    config[`${owner}FontWeight`];
  return {
    ...(family ? { "font-family": family } : {}),
    ...(size !== undefined ? { "font-size": String(size) } : {}),
    ...(weight !== undefined ? { "font-weight": String(weight) } : {}),
  };
}
/** Authored native colors affect content; selection chrome keeps its shared theme. */
export function c4ProjectedContentStyle(
  owner: Pick<MermaidVisualNode, "familyData">,
) {
  return projectMermaidSourceStyle(
    mermaidVisualFamilyPayload(owner.familyData, "c4")?.styles,
  );
}

/** SVG's paint keyword is not a Canvas color assignment. */
export function c4NoPaint(value: string | undefined) {
  return value?.trim().toLowerCase() === "none";
}
