// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  isAlias,
  isMap,
  isScalar,
  parseDocument,
  stringify,
  type Node,
  type YAMLMap,
} from "yaml";

export type SourceValuePatch = {
  range: { start: number; end: number };
  value: string;
};

/** Mermaid accepts a shared frontmatter indentation prefix, including tabs.
 * Replace only that prefix with equal-length spaces so CST offsets still refer
 * to authored Source. Changed/new lines can restore the original prefix. */
export function sourceFrontmatter(source: string) {
  const open = /^([ \t]*)---[ \t]*(?:\r\n|\r|\n)/.exec(source);
  if (!open) return null;
  const prefix = open[1]!;
  const closing = new RegExp(
    `(?:\\r\\n|\\r|\\n)${prefix}---[ \\t]*(?=\\r\\n|\\r|\\n|$)`,
  ).exec(source.slice(open[0].length));
  if (!closing) return null;
  const start = open[0].length,
    end = start + closing.index;
  const body = source
    .slice(start, end)
    .split(/(?<=\n)|(?<=\r)(?!\n)/)
    .map((line) =>
      prefix && line.startsWith(prefix)
        ? " ".repeat(prefix.length) + line.slice(prefix.length)
        : line,
    )
    .join("");
  return {
    body,
    start,
    end,
    prefix,
    closingStart: end + (/^\r\n|^\r|^\n/.exec(closing[0])?.[0].length ?? 0),
  };
}

export function restoreFrontmatterPrefix(value: string, prefix: string) {
  if (!prefix) return value;
  return value
    .split(/(?<=\n)|(?<=\r)(?!\n)/)
    .map((line) =>
      line.startsWith(" ".repeat(prefix.length))
        ? prefix + line.slice(prefix.length)
        : line,
    )
    .join("");
}

/** Decode bounded YAML with CST ranges. Duplicate keys are opt-in for native
 * JSON owners; reads and patches then address the last occurrence. */
export function readSourceYaml(
  raw: string,
  offset: number,
  { allowDuplicateKeys = false } = {},
) {
  const document = parseDocument(raw, {
    keepSourceTokens: true,
    uniqueKeys: !allowDuplicateKeys,
    schema: "core",
  });
  try {
    if (
      document.errors.length ||
      (document.contents !== null && !isMap(document.contents))
    )
      return null;
    const values = (document.toJS({ maxAliasCount: 100 }) ?? {}) as Record<
      string,
      unknown
    >;
    return { document, values, offset, raw };
  } catch {
    return null;
  }
}
export type SourceYaml = NonNullable<ReturnType<typeof readSourceYaml>> & {
  /** Native grammar may concatenate metadata bodies separated by @{...} delimiters. */
  positions?: readonly number[];
};

/** Compare decoded YAML graphs without serializing aliases or recursing through cycles. */
export function sourceValuesEqual(
  left: unknown,
  right: unknown,
  seen = new WeakMap<object, object>(),
): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object")
    return false;
  if (seen.has(left)) return seen.get(left) === right;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  seen.set(left, right);
  const entries = Object.entries(left);
  return (
    entries.length === Object.keys(right).length &&
    entries.every(
      ([key, value]) =>
        Object.hasOwn(right, key) &&
        sourceValuesEqual(value, (right as Record<string, unknown>)[key], seen),
    )
  );
}

function encodedValue(value: unknown) {
  // JSON is the compact native YAML subset; YAML anchors retain a cyclic decoded value.
  try {
    return JSON.stringify(value);
  } catch {
    return stringify(value, { collectionStyle: "flow" }).trimEnd();
  }
}

/** Concatenation is native Kanban grammar. Logical CST offsets map back to untouched physical bodies. */
export function readSourceYamlParts(
  parts: readonly { raw: string; offset: number }[],
): SourceYaml | null {
  const content = parts.map((part) => part.raw).join("");
  const flow = !/[\r\n]/.test(content);
  const raw = flow ? `{${content}}` : content;
  const yaml = readSourceYaml(raw, 0);
  if (!yaml) return null;
  const positions: number[] = flow ? [parts[0]!.offset - 1] : [];
  for (const part of parts)
    for (let index = 0; index < part.raw.length; index++)
      positions.push(part.offset + index);
  const last = parts.at(-1)!;
  positions.push(last.offset + last.raw.length);
  if (flow) positions.push(last.offset + last.raw.length + 1);
  return { ...yaml, positions };
}

/** Patch a map reference, never an aliased definition shared by another source owner. */
function logicalSourceYamlFieldPatch(
  yaml: SourceYaml,
  path: readonly string[],
  value: unknown,
): SourceValuePatch[] | null {
  let previous: unknown = yaml.values;
  for (const key of path)
    previous =
      previous && typeof previous === "object"
        ? (previous as Record<string, unknown>)[key]
        : undefined;
  if (sourceValuesEqual(previous, value)) return [];
  let currentNode = yaml.document.getIn(path, true);
  if (yaml.document.options.uniqueKeys === false) {
    currentNode = yaml.document.contents;
    for (const key of path)
      currentNode = isMap(currentNode)
        ? currentNode.items.findLast(
            (pair) => isScalar(pair.key) && pair.key.value === key,
          )?.value
        : undefined;
  }
  // A map edit owns changed leaves, not the spelling/quotes of its untouched neighbors.
  // An alias is one reference: materialize that reference instead of editing its shared definition.
  if (
    isMap(currentNode) &&
    previous &&
    value &&
    typeof previous === "object" &&
    typeof value === "object" &&
    !Array.isArray(previous) &&
    !Array.isArray(value)
  ) {
    const patches: SourceValuePatch[] = [];
    for (const key of new Set([
      ...Object.keys(previous),
      ...Object.keys(value),
    ])) {
      if (
        sourceValuesEqual(
          (previous as Record<string, unknown>)[key],
          (value as Record<string, unknown>)[key],
        )
      )
        continue;
      const changed = logicalSourceYamlFieldPatch(
        yaml,
        [...path, key],
        (value as Record<string, unknown>)[key],
      );
      if (!changed) return null;
      patches.push(...changed);
    }
    return patches;
  }
  if (!yaml.document.contents) {
    if (value === undefined) return [];
    let nested: unknown = value;
    for (const key of path.slice(1).reverse()) nested = { [key]: nested };
    const newline = yaml.raw.includes("\r\n")
      ? "\r\n"
      : yaml.raw.includes("\r")
        ? "\r"
        : "\n";
    return [
      {
        range: { start: yaml.offset, end: yaml.offset },
        value: `${JSON.stringify(path[0])}: ${encodedValue(nested)}${newline}`,
      },
    ];
  }
  let scope: YAMLMap = yaml.document.contents as YAMLMap;
  for (let index = 0; index < path.length - 1; index++) {
    const child = scope.items.findLast(
      (pair) => isScalar(pair.key) && pair.key.value === path[index],
    )?.value;
    if (isAlias(child)) {
      if (!child.range) return null;
      const resolved = child.resolve(yaml.document);
      if (!isMap(resolved)) return null;
      let branch: unknown = yaml.values;
      for (const key of path.slice(0, index + 1))
        branch = (branch as Record<string, unknown>)[key];
      const copy = structuredClone(branch) as Record<string, unknown>;
      let nested = copy;
      for (const key of path.slice(index + 1, -1)) {
        const old = nested[key];
        nested[key] =
          old && typeof old === "object" && !Array.isArray(old)
            ? { ...old }
            : {};
        nested = nested[key] as Record<string, unknown>;
      }
      if (value === undefined) delete nested[path.at(-1)!];
      else nested[path.at(-1)!] = value;
      return [
        {
          range: {
            start: yaml.offset + child.range[0],
            end: yaml.offset + child.range[1],
          },
          value: encodedValue(copy),
        },
      ];
    }
    if (!isMap(child)) {
      if (child !== undefined) return null;
      let nested: unknown = value;
      if (value === undefined) return [];
      for (const key of path.slice(index + 1).reverse())
        nested = { [key]: nested };
      return sourceYamlMapPatch(yaml, scope, path[index]!, nested);
    }
    scope = child;
  }
  return sourceYamlMapPatch(yaml, scope, path.at(-1)!, value);
}

function sourceYamlMapPatch(
  yaml: SourceYaml,
  scope: YAMLMap,
  key: string,
  value: unknown,
): SourceValuePatch[] | null {
  const pairIndex = scope.items.findLastIndex(
    (pair) => isScalar(pair.key) && String(pair.key.value) === key,
  );
  const pair = scope.items[pairIndex];
  if (pair && pair.value && isScalar(pair.key)) {
    const node = pair.value as Node;
    if (!node.range || !pair.key.range) return null;
    if (value !== undefined) {
      let encoded = encodedValue(value);
      if (yaml.positions && !scope.flow && value && typeof value === "object") {
        const start =
          Math.max(
            yaml.raw.lastIndexOf("\n", node.range[0] - 1),
            yaml.raw.lastIndexOf("\r", node.range[0] - 1),
          ) + 1;
        const prefix = yaml.raw.slice(start, node.range[0]);
        const indent = /^\s*/.exec(prefix)![0];
        const ownLine = !prefix.trim();
        const nestedIndent = ownLine ? indent : indent + "  ";
        const newline = yaml.raw.includes("\r\n")
          ? "\r\n"
          : yaml.raw.includes("\r")
            ? "\r"
            : "\n";
        const lines = stringify(value, { collectionStyle: "block" })
          .trimEnd()
          .split("\n");
        encoded =
          (ownLine ? "" : newline + nestedIndent) +
          lines.join(newline + nestedIndent);
        if (/\r?\n$/.test(yaml.raw.slice(node.range[0], node.range[1])))
          encoded += newline;
      }
      return [
        {
          range: {
            start: yaml.offset + node.range[0],
            end: yaml.offset + node.range[1],
          },
          value: encoded,
        },
      ];
    }
    const patches: SourceValuePatch[] = [
      {
        range: {
          start: yaml.offset + pair.key.range[0],
          end: yaml.offset + node.range[1],
        },
        value: "",
      },
    ];
    if (scope.flow && scope.items.length > 1) {
      const token = scope.srcToken;
      const comma =
        token?.type === "flow-collection"
          ? token.items[
              pairIndex + 1 < scope.items.length ? pairIndex + 1 : pairIndex
            ]?.start.find((item) => item.type === "comma")
          : undefined;
      if (!comma) return null;
      patches.push({
        range: {
          start: yaml.offset + comma.offset,
          end: yaml.offset + comma.offset + comma.source.length,
        },
        value: "",
      });
    }
    return patches;
  }
  if (value === undefined) return [];
  if (!scope.range) return null;
  if (scope.flow) {
    const end = yaml.offset + scope.range[1] - 1;
    return [
      {
        range: { start: end, end },
        value: `${scope.items.length ? ", " : ""}${JSON.stringify(key)}: ${encodedValue(value)}`,
      },
    ];
  }
  const first = scope.items[0]?.key as Node | undefined;
  const position = first?.range?.[0] ?? scope.range[0];
  const start =
    Math.max(
      yaml.raw.lastIndexOf("\n", position - 1),
      yaml.raw.lastIndexOf("\r", position - 1),
    ) + 1;
  const newline = yaml.raw.includes("\r\n")
    ? "\r\n"
    : yaml.raw.includes("\r")
      ? "\r"
      : "\n";
  return [
    {
      range: { start: yaml.offset + start, end: yaml.offset + start },
      value:
        yaml.positions && value && typeof value === "object"
          ? stringify({ [key]: value }, { collectionStyle: "block" })
              .trimEnd()
              .split("\n")
              .map((line) => yaml.raw.slice(start, position) + line)
              .join(newline) + newline
          : `${yaml.raw.slice(start, position)}${key}: ${encodedValue(value)}${newline}`,
    },
  ];
}

/** A field may not span a foreign delimiter. Insertions use the owning body's native closing boundary. */
export function sourceYamlFieldPatch(
  yaml: SourceYaml,
  path: readonly string[],
  value: unknown,
): SourceValuePatch[] | null {
  const patches = logicalSourceYamlFieldPatch(yaml, path, value);
  if (!patches || !yaml.positions) return patches;
  const result: SourceValuePatch[] = [];
  for (const patch of patches) {
    const start = yaml.positions[patch.range.start];
    const end =
      patch.range.end === patch.range.start
        ? start
        : (yaml.positions[patch.range.end - 1] ?? -1) + 1;
    if (
      start === undefined ||
      end - start !== patch.range.end - patch.range.start
    )
      return null;
    result.push({ ...patch, range: { start, end } });
  }
  return result;
}
