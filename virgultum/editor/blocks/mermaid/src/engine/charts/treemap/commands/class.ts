// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  TreemapClassDef,
  TreemapClassDeclaration,
  TreemapModel,
} from "../model.js";
import { treemapRecordRangeWithEnding } from "../source-document.js";
import {
  treemapNoChange,
  treemapPatchedResult,
  type TreemapPatch,
} from "../writer.js";

export type TreemapClassCommand =
  | {
      readonly type: "class.add";
      readonly name: string;
      readonly declarations: readonly TreemapClassDeclaration[];
    }
  | {
      readonly type: "class.declarations";
      readonly id: string;
      readonly declarations: readonly TreemapClassDeclaration[];
    }
  | {
      readonly type: "class.declaration.add";
      readonly id: string;
      readonly property: string;
      readonly value: string;
    }
  | {
      readonly type: "class.declaration.update";
      readonly id: string;
      readonly index: number;
      readonly property: string;
      readonly value: string;
    }
  | {
      readonly type: "class.declaration.reorder";
      readonly id: string;
      readonly index: number;
      readonly nextIndex: number;
    }
  | {
      readonly type: "class.declaration.delete";
      readonly id: string;
      readonly index: number;
    }
  | {
      readonly type: "class.rename";
      readonly name: string;
      readonly nextName: string;
    }
  | {
      readonly type: "class.delete";
      readonly id: string;
      readonly assignmentStrategy?: "remove" | "reassign";
      readonly replacement?: string;
      readonly confirmed?: boolean;
    }
  | {
      readonly type: "class.assign";
      readonly nodeId: string;
      readonly name: string | null;
    };

function validName(value: string) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function declarationSource(declarations: readonly TreemapClassDeclaration[]) {
  if (
    declarations.some(
      ({ property, value }) =>
        !property.trim() || /[\r\n,;:]/.test(property) || /[\r\n;]/.test(value),
    )
  )
    return null;
  return declarations
    .map(({ property, value, raw }) => {
      const rawColon = raw.indexOf(":");
      const rawProperty =
        rawColon < 0 ? raw.trim() : raw.slice(0, rawColon).trim();
      const rawValue = rawColon < 0 ? "" : raw.slice(rawColon + 1).trim();
      return raw && rawProperty === property && rawValue === value
        ? raw
        : `${property.trim()}:${value.trim().replaceAll(",", "\\,")}`;
    })
    .join(",");
}

function updatedDeclarations(
  classDef: TreemapClassDef,
  command: Extract<
    TreemapClassCommand,
    {
      type:
        | "class.declaration.add"
        | "class.declaration.update"
        | "class.declaration.reorder"
        | "class.declaration.delete";
    }
  >,
) {
  const declarations = [...classDef.declarations];
  if (command.type === "class.declaration.add") {
    return [
      ...declarations,
      {
        property: command.property.trim(),
        value: command.value.trim(),
        raw: "",
      },
    ];
  } else if (command.type === "class.declaration.update") {
    if (!declarations[command.index]) return null;
    return declarations.map((declaration, index) =>
      index === command.index
        ? {
            property: command.property.trim(),
            value: command.value.trim(),
            raw: "",
          }
        : declaration,
    );
  } else if (command.type === "class.declaration.delete") {
    if (!declarations[command.index]) return null;
    return declarations.filter((_, index) => index !== command.index);
  } else {
    if (
      !declarations[command.index] ||
      !declarations[command.nextIndex] ||
      command.index === command.nextIndex
    )
      return null;
    const moved = declarations[command.index];
    const withoutMoved = declarations.filter(
      (_, index) => index !== command.index,
    );
    return [
      ...withoutMoved.slice(0, command.nextIndex),
      moved,
      ...withoutMoved.slice(command.nextIndex),
    ];
  }
}

function recordForClass(model: TreemapModel, classDef: TreemapClassDef) {
  return model.sourceDocument.records.find(
    (record) => record.id === classDef.recordId,
  );
}

export function applyTreemapClassCommand(
  model: TreemapModel,
  command: TreemapClassCommand,
) {
  if (command.type === "class.add") {
    const style = declarationSource(command.declarations);
    if (!validName(command.name) || style === null)
      return treemapNoChange(model, "invalid-class");
    const newline = model.sourceDocument.newline;
    const offset = model.sourceDocument.source.length;
    const prefix =
      offset && !/[\r\n]$/.test(model.sourceDocument.source) ? newline : "";
    const recordId = crypto.randomUUID();
    const result = treemapPatchedResult(
      model,
      [
        {
          range: { start: offset, end: offset },
          value: `${prefix}classDef ${command.name}${style ? ` ${style}` : ""};${newline}`,
        },
      ],
      null,
      new Map([[offset + prefix.length, recordId]]),
    );
    const created = result.model.classDefs.find(
      (candidate) => candidate.recordId === recordId,
    );
    return created
      ? { ...result, selection: { kind: "class-def" as const, id: created.id } }
      : result;
  }
  if (command.type === "class.assign") {
    const node = model.nodes.find(
      (candidate) => candidate.id === command.nodeId,
    );
    if (!node) return treemapNoChange(model, "node-missing");
    if (command.name && !validName(command.name))
      return treemapNoChange(model, "invalid-class");
    const record = model.sourceDocument.records.find(
      (candidate) => candidate.id === node.recordId,
    );
    if (!record) return treemapNoChange(model, "conflict");
    const patch = node.classRange
      ? {
          range: command.name
            ? node.classRange
            : { start: node.classRange.start - 3, end: node.classRange.end },
          value: command.name ?? "",
        }
      : {
          range: { start: record.range.end, end: record.range.end },
          value: command.name ? `:::${command.name}` : "",
        };
    return treemapPatchedResult(model, [patch], {
      kind: "node",
      id: node.id,
    });
  }
  if (command.type === "class.rename") {
    if (
      !validName(command.nextName) ||
      model.classDefs.some((item) => item.name === command.nextName)
    )
      return treemapNoChange(model, "class-name-conflict");
    const definitions = model.classDefs.filter(
      (item) => item.name === command.name,
    );
    if (!definitions.length) return treemapNoChange(model, "class-missing");
    const patches: TreemapPatch[] = [
      ...definitions.map((item) => ({
        range: item.nameRange,
        value: command.nextName,
      })),
      ...model.nodes.flatMap((node) =>
        node.className === command.name && node.classRange
          ? [{ range: node.classRange, value: command.nextName }]
          : [],
      ),
    ];
    return treemapPatchedResult(model, patches, {
      kind: "class-def",
      id: definitions[0].id,
    });
  }
  const classDef = model.classDefs.find(
    (candidate) => candidate.id === command.id,
  );
  if (!classDef) return treemapNoChange(model, "class-missing");
  const record = recordForClass(model, classDef);
  if (!record) return treemapNoChange(model, "conflict");
  if (
    command.type === "class.declarations" ||
    command.type.startsWith("class.declaration.")
  ) {
    const declarations =
      command.type === "class.declarations"
        ? command.declarations
        : updatedDeclarations(
            classDef,
            command as Extract<
              TreemapClassCommand,
              { type: `class.declaration.${string}` }
            >,
          );
    if (!declarations) return treemapNoChange(model, "invalid-class");
    const style = declarationSource(declarations);
    if (style === null) return treemapNoChange(model, "invalid-class");
    const patch = classDef.styleRange
      ? { range: classDef.styleRange, value: style }
      : {
          range: { start: classDef.nameRange.end, end: classDef.nameRange.end },
          value: style ? ` ${style}` : "",
        };
    return treemapPatchedResult(model, [patch], {
      kind: "class-def",
      id: classDef.id,
    });
  }
  if (command.type !== "class.delete")
    return treemapNoChange(model, "invalid-class");
  const sameName = model.classDefs.filter(
    (candidate) => candidate.name === classDef.name,
  );
  const assigned = model.nodes.filter(
    (node) => node.className === classDef.name,
  );
  const comments = model.comments
    .filter(
      (comment) =>
        comment.anchor.kind === "class-def" &&
        comment.anchor.id === classDef.id,
    )
    .map((comment) =>
      model.sourceDocument.records.find(
        (record) => record.id === comment.recordId,
      ),
    )
    .filter((record): record is NonNullable<typeof record> => Boolean(record));
  if (
    ((sameName.length === 1 && assigned.length > 0) || comments.length > 0) &&
    !command.confirmed
  )
    return treemapNoChange(model, "confirmation-required");
  const definitionRange = treemapRecordRangeWithEnding(
    model.sourceDocument,
    record,
  );
  const patches: TreemapPatch[] = [
    {
      range: {
        start: comments.reduce(
          (start, comment) => Math.min(start, comment.range.start),
          definitionRange.start,
        ),
        end: definitionRange.end,
      },
      value: "",
    },
  ];
  let assignmentPatches: TreemapPatch[] = [];
  if (sameName.length === 1 && assigned.length) {
    if (command.assignmentStrategy === "reassign") {
      if (
        !command.replacement ||
        !model.classDefs.some((item) => item.name === command.replacement)
      )
        return treemapNoChange(model, "invalid-class");
      assignmentPatches = assigned.flatMap((node) =>
        node.classRange
          ? [{ range: node.classRange, value: command.replacement! }]
          : [],
      );
    } else if (command.assignmentStrategy === "remove") {
      assignmentPatches = assigned.flatMap((node) =>
        node.classRange
          ? [
              {
                range: {
                  start: node.classRange.start - 3,
                  end: node.classRange.end,
                },
                value: "",
              },
            ]
          : [],
      );
    } else return treemapNoChange(model, "assignment-strategy-required");
  }
  return treemapPatchedResult(model, [...patches, ...assignmentPatches], null);
}
