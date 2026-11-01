// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidVisualNodeDetail } from "../runtime/gfx-model.js";
import {
  parseMermaidClassMember,
  type MermaidClassMember,
} from "../../engine/class/index.js";
export function createClassMemberDetails(
  ownerId: string,
  members: readonly (string | MermaidClassMember)[] | undefined,
  memberKeys: readonly string[] = [],
): MermaidVisualNodeDetail[] {
  return (members ?? [])
    .map((value, sourceIndex) => {
      const member =
        typeof value === "string"
          ? parseMermaidClassMember(value, {
              id: memberKeys[sourceIndex],
              classId: ownerId,
            })
          : value;
      return {
        id: member.id,
        kind:
          member.kind === "operation"
            ? ("operation" as const)
            : ("field" as const),
        label: member.raw,
        order: sourceIndex,
        sourceKey: member.id,
      };
    })
    .sort((left, right) => {
      if (left.kind === right.kind) return left.order - right.order;
      return left.kind === "field" ? -1 : 1;
    })
    .map((detail, order) => ({ ...detail, order }));
}
