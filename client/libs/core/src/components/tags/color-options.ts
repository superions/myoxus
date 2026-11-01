import { WORKSPACE_TAG_COLOR_ROLES } from "@myoxus/core/modules/tag";
import { useI18n } from "@myoxus/i18n";
import { useMemo } from "react";

import type { TagColor } from "./types";

export type WorkspaceTagColorOption = TagColor & { name: string };

const workspaceTagColorLabelKeys = {
  "tag.red": "com.myoxus.tags.color.red",
  "tag.magenta": "com.myoxus.tags.color.magenta",
  "tag.orange": "com.myoxus.tags.color.orange",
  "tag.yellow": "com.myoxus.tags.color.yellow",
  "tag.green": "com.myoxus.tags.color.green",
  "tag.teal": "com.myoxus.tags.color.teal",
  "tag.blue": "com.myoxus.tags.color.blue",
  "tag.purple": "com.myoxus.tags.color.purple",
  "tag.grey": "com.myoxus.tags.color.grey",
} as const satisfies Record<(typeof WORKSPACE_TAG_COLOR_ROLES)[number], string>;

/**
 * Presents server-owned tag color roles without exposing theme tokens to product
 * code. The Facade owns the visual projection; this hook owns localized labels.
 */
export function useWorkspaceTagColorOptions(): WorkspaceTagColorOption[] {
  const t = useI18n();

  return useMemo(
    () =>
      WORKSPACE_TAG_COLOR_ROLES.map((value) => ({
        id: value,
        value,
        name: t[workspaceTagColorLabelKeys[value]](),
      })),
    [t],
  );
}
