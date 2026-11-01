// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MermaidC4Boundary,
  MermaidC4Element,
  MermaidC4Relationship,
} from "./model.js";
import {
  elementArgumentIndexes,
  boundaryArgumentIndexes,
  relationshipArgumentIndexes,
} from "./runtime-contract.js";
import {
  setArgumentValue,
  trimTrailingEmptyArguments,
} from "./commands/update-commands.js";
import { remapC4ElementArguments } from "./kind-arguments.js";
import { C4WriteError } from "./patches.js";

export function elementArguments(
  element: MermaidC4Element,
  previous?: MermaidC4Element,
) {
  const set = (
    index: number,
    names: string[],
    value: string,
    field: keyof typeof element,
  ) => {
    if (!previous || previous[field] !== element[field]) {
      setArgumentValue(args, index, names, value);
      if (previous && previous[field] !== element[field])
        minimumLength = Math.max(minimumLength, index + 1);
    }
  };
  const migration =
    previous && previous.kind !== element.kind
      ? remapC4ElementArguments(
          previous.kind,
          element.kind,
          previous.callArguments,
        )
      : undefined;
  if (migration?.lost.length)
    throw new C4WriteError(
      "Confirm the C4 Technology slot loss through the local kind command",
    );
  const args =
    migration?.arguments ??
    element.callArguments.map((argument) => ({ ...argument }));
  let minimumLength = Math.max(args.length, 2);
  const indexes = elementArgumentIndexes(element.kind);
  if (
    migration &&
    indexes.technology >= 0 &&
    elementArgumentIndexes(previous!.kind).technology < 0
  )
    setArgumentValue(args, indexes.technology, ["techn"], element.technology);
  set(0, ["alias"], element.alias, "alias");
  set(1, ["label"], element.label, "label");
  if (indexes.technology >= 0) {
    set(
      indexes.technology,
      ["techn", "technology"],
      element.technology,
      "technology",
    );
  }
  set(
    indexes.description,
    ["descr", "description"],
    element.description,
    "description",
  );
  set(indexes.sprite, ["sprite"], element.sprite, "sprite");
  set(indexes.tags, ["tags"], element.tags, "tags");
  set(indexes.link, ["link"], element.link, "link");
  // A changed field may need a new explicit empty slot to clear an earlier provider.
  return trimTrailingEmptyArguments(args, minimumLength);
}

export function boundaryArguments(
  boundary: MermaidC4Boundary,
  previous?: MermaidC4Boundary,
) {
  const set = (
    index: number,
    names: string[],
    value: string,
    field: keyof typeof boundary,
  ) => {
    if (
      !previous ||
      previous.kind !== boundary.kind ||
      previous[field] !== boundary[field]
    ) {
      setArgumentValue(args, index, names, value);
      if (previous && previous[field] !== boundary[field])
        minimumLength = Math.max(minimumLength, index + 1);
    }
  };
  const args = boundary.callArguments.map((argument) => ({ ...argument }));
  let minimumLength = Math.max(args.length, 2);
  const indexes = boundaryArgumentIndexes(boundary.kind);
  set(0, ["alias"], boundary.id, "id");
  set(1, ["label"], boundary.label, "label");
  if (indexes.type >= 0)
    set(indexes.type, ["type"], boundary.boundaryType, "boundaryType");
  if (indexes.description >= 0) {
    set(
      indexes.description,
      ["descr", "description"],
      boundary.description,
      "description",
    );
  }
  if (indexes.sprite >= 0)
    set(indexes.sprite, ["sprite"], boundary.sprite, "sprite");
  set(indexes.tags, ["tags"], boundary.tags, "tags");
  set(indexes.link, ["link"], boundary.link, "link");
  return trimTrailingEmptyArguments(args, minimumLength);
}

export function relationshipArguments(
  relationship: MermaidC4Relationship,
  previous?: MermaidC4Relationship,
) {
  const set = (
    index: number,
    names: string[],
    value: string,
    field: keyof typeof relationship,
  ) => {
    if (
      !previous ||
      previous.kind !== relationship.kind ||
      previous[field] !== relationship[field]
    ) {
      setArgumentValue(args, index, names, value);
      if (previous && previous[field] !== relationship[field])
        minimumLength = Math.max(minimumLength, index + 1);
    }
  };
  const args = relationship.callArguments.map((argument) => ({ ...argument }));
  let minimumLength = Math.max(
    args.length,
    relationship.kind === "RelIndex" ? 4 : 3,
  );
  const indexes = relationshipArgumentIndexes(relationship.kind);
  if (relationship.kind === "RelIndex") {
    if (!previous || previous.index !== relationship.index)
      setArgumentValue(args, 0, ["index"], String(relationship.index ?? 0));
  }
  set(indexes.from, ["from"], relationship.from, "from");
  set(indexes.to, ["to"], relationship.to, "to");
  set(indexes.label, ["label"], relationship.label, "label");
  set(
    indexes.technology,
    ["techn", "technology"],
    relationship.technology,
    "technology",
  );
  set(
    indexes.description,
    ["descr", "description"],
    relationship.description,
    "description",
  );
  set(indexes.sprite, ["sprite"], relationship.sprite, "sprite");
  set(indexes.tags, ["tags"], relationship.tags, "tags");
  set(indexes.link, ["link"], relationship.link, "link");
  return trimTrailingEmptyArguments(args, minimumLength);
}
