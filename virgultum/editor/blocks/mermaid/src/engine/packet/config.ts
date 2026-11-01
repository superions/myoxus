// SPDX-License-Identifier: AGPL-3.0-or-later

import { mermaidMessages as messages } from "../../i18n.js";
import {
  sourceYamlFieldPatch,
  readSourceYaml,
  type SourceYaml,
} from "../source-yaml.js";
import type {
  PacketSourceDocument,
  PacketSourceRecord,
} from "./source-document.js";
export const PACKET_CONFIG_FIELDS = [
  "rowHeight",
  "bitWidth",
  "bitsPerRow",
  "showBits",
  "paddingX",
  "paddingY",
  "useMaxWidth",
] as const;
export type PacketConfigField = (typeof PACKET_CONFIG_FIELDS)[number];
export type PacketConfig = {
  rowHeight: number;
  bitWidth: number;
  bitsPerRow: number;
  showBits: boolean;
  paddingX: number;
  paddingY: number;
  useMaxWidth: boolean;
};
export const PACKET_DEFAULT_CONFIG: PacketConfig = {
  rowHeight: 32,
  bitWidth: 32,
  bitsPerRow: 32,
  showBits: true,
  paddingX: 5,
  paddingY: 5,
  useMaxWidth: true,
};
export type PacketConfigScope = {
  record: PacketSourceRecord;
  yaml: SourceYaml;
  path: string[];
};
export type PacketConfigIssue = {
  field: string;
  line: number;
  message: string;
};
export function isPacketConfigValue(field: PacketConfigField, value: unknown) {
  if (field === "showBits" || field === "useMaxWidth")
    return typeof value === "boolean";
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    return false;
  return field !== "bitsPerRow" || (Number.isSafeInteger(value) && value > 0);
}
/** Native preprocessing merges frontmatter first, then init directives in Source order.
 * Derived bit-label padding never replaces the configured paddingY. */
export function readPacketConfig(document: PacketSourceDocument) {
  const effective: Record<PacketConfigField, unknown> = {
    ...PACKET_DEFAULT_CONFIG,
  };
  const scopes: PacketConfigScope[] = [];
  const invalid: PacketConfigIssue[] = [];
  const records = document.records
    .filter((r) => r.kind === "frontmatter" || r.kind === "directive")
    .sort(
      (a, b) =>
        Number(b.kind === "frontmatter") - Number(a.kind === "frontmatter"),
    );
  for (const record of records) {
    if (
      record.kind === "directive" &&
      !/^%%\{\s*(?:init|initialize)\s*:/i.test(record.raw.trim())
    )
      continue;
    const start =
      record.kind === "frontmatter"
        ? record.raw.indexOf("\n") + 1
        : record.raw.indexOf("%%{") + 2;
    const end =
      record.kind === "frontmatter"
        ? record.raw.lastIndexOf("---")
        : record.raw.lastIndexOf("}%%") + 1;
    const yaml = record.complete
      ? readSourceYaml(record.raw.slice(start, end), record.range.start + start)
      : null;
    if (!yaml) {
      invalid.push({
        field: "config",
        line: record.range.line,
        get message() {
          return messages.packetConfigUnresolved();
        },
      });
      continue;
    }
    const prefix =
      record.kind === "frontmatter"
        ? "config"
        : "init" in yaml.values
          ? "init"
          : "initialize";
    const root = yaml.values[prefix];
    const values =
      root && typeof root === "object" && !Array.isArray(root)
        ? (root as Record<string, unknown>)
        : {};
    // Native detectInit maps a legacy directive's config payload to the detected diagram.
    const path =
      record.kind === "directive" && Object.hasOwn(values, "config")
        ? [prefix, "config"]
        : [prefix, "packet"];
    const packet = values[path[1]!];
    const scope = { record, yaml, path };
    scopes.push(scope);
    if (!packet || typeof packet !== "object" || Array.isArray(packet))
      continue;
    for (const field of PACKET_CONFIG_FIELDS) {
      if (Object.hasOwn(packet, field))
        effective[field] = (packet as Record<string, unknown>)[field];
    }
  }
  for (const field of PACKET_CONFIG_FIELDS) {
    if (!isPacketConfigValue(field, effective[field])) {
      const owner = scopes.findLast((s) => {
        const root = s.yaml.values[s.path[0]!] as Record<string, unknown>;
        const packet = root?.[s.path[1]!] as
          Record<string, unknown> | undefined;
        return packet && Object.hasOwn(packet, field);
      });
      invalid.push({
        field,
        line: owner?.record.range.line ?? 1,
        get message() {
          return packetConfigValueDiagnostic(field, effective[field])!;
        },
      });
    }
  }
  const config = invalid.length ? null : (effective as PacketConfig);
  return {
    effective,
    scopes,
    invalid,
    config,
    derivedPaddingY: config
      ? config.paddingY + (config.showBits ? 10 : 0)
      : null,
    mutableGeometry: Boolean(
      config && config.bitWidth > 0 && config.rowHeight > 0,
    ),
  };
}

/** Group edits by the effective owning scope. Shared CST patching changes only
 * confirmed leaves, retaining foreign config and earlier shadowed declarations. */
export function packetConfigPatches(
  model: import("./model.js").MermaidPacketModel,
  changes: Partial<PacketConfig>,
) {
  const { scopes, effective } = model.configResolution;
  const grouped = new Map<PacketConfigScope, Record<string, unknown>>();
  const missing: Partial<PacketConfig> = {};
  for (const field of PACKET_CONFIG_FIELDS) {
    if (
      !Object.hasOwn(changes, field) ||
      Object.is(changes[field], effective[field])
    )
      continue;
    const value = changes[field];
    if (!isPacketConfigValue(field, value)) return null;
    const owner =
      scopes.findLast((s) => {
        const root = s.yaml.values[s.path[0]!] as
          Record<string, unknown> | undefined;
        const packet = root?.[s.path[1]!] as
          Record<string, unknown> | undefined;
        return packet && Object.hasOwn(packet, field);
      }) ?? scopes.at(-1);
    if (!owner) {
      Object.assign(missing, { [field]: value });
      continue;
    }
    let values = grouped.get(owner);
    if (!values) {
      const root = owner.yaml.values[owner.path[0]!] as
        Record<string, unknown> | undefined;
      const packet = root?.[owner.path[1]!];
      values =
        packet && typeof packet === "object" && !Array.isArray(packet)
          ? { ...packet }
          : {};
      grouped.set(owner, values);
    }
    values[field] = value;
  }
  const patches: import("./writer.js").PacketPatch[] = [];
  for (const [owner, values] of grouped) {
    const result = sourceYamlFieldPatch(owner.yaml, owner.path, values);
    if (!result) return null;
    patches.push(...result);
  }
  if (Object.keys(missing).length) {
    const header = model.sourceDocument.records.find(
      (r) => r.kind === "header",
    );
    if (!header) return null;
    patches.push({
      range: { start: header.range.start, end: header.range.start },
      value: `%%{init: ${JSON.stringify({ packet: missing })}}%%${model.sourceDocument.newline}`,
    });
  }
  return patches;
}

export function packetConfigLabel(field: PacketConfigField) {
  return {
    rowHeight: messages.packetRowHeight,
    bitWidth: messages.packetBitWidth,
    bitsPerRow: messages.packetBitsPerRow,
    showBits: messages.packetShowBits,
    paddingX: messages.packetPaddingX,
    paddingY: messages.packetPaddingY,
    useMaxWidth: messages.packetUseMaxWidth,
  }[field]();
}

/** Resolution and appearance drafts share the same typed value diagnosis. */
export function packetConfigValueDiagnostic(
  field: PacketConfigField,
  value: unknown,
) {
  if (isPacketConfigValue(field, value)) return undefined;
  return field === "bitsPerRow"
    ? messages.packetConfigBits()
    : field === "showBits" || field === "useMaxWidth"
      ? messages.packetConfigBoolean(packetConfigLabel(field))
      : messages.packetConfigNumber(packetConfigLabel(field));
}
