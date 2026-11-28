// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { DocCustomPropertyInfo } from "@myoxus/core/modules/db";

import { SystemPropertyTypes } from "../system-property-types";

export interface ExplorerPropertyEntry {
  systemProperty?: (typeof SystemPropertyTypes)[number] & { type: string };
  workspaceProperty?: DocCustomPropertyInfo;
}

/**
 * Merges canonical system properties with user-defined workspace properties so
 * explorer display/sort/group settings remain stable when users rename or hide
 * system property definitions.
 */
export function generateExplorerPropertyList(
  workspaceProperties: DocCustomPropertyInfo[],
  options: { includeAllPagesOnly?: boolean } = {},
): ExplorerPropertyEntry[] {
  const entries: ExplorerPropertyEntry[] = [];
  const unmatched = [...workspaceProperties];

  for (const [type, descriptor] of Object.entries(SystemPropertyTypes)) {
    if (descriptor.allPagesOnly && !options.includeAllPagesOnly) continue;
    const matchIndex = unmatched.findIndex((prop) => prop.type === type);
    if (matchIndex === -1) {
      entries.push({ systemProperty: { ...descriptor, type } });
    } else {
      const [workspaceProperty] = unmatched.splice(matchIndex, 1);
      entries.push({
        systemProperty: { ...descriptor, type },
        workspaceProperty,
      });
    }
  }

  for (const workspaceProperty of unmatched) {
    entries.push({ workspaceProperty });
  }

  return entries;
}
