// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useI18n } from "@myoxus/i18n";
import { ChevronDownIcon, ChevronRightIcon } from "@myoxus/icons/react";
import { IconButton } from "@myoxus/ui-facade";
import type { EditorDisclosureControl } from "@virgultum/editor/shared/services";

export function EditorDisclosureToggle({
  controls,
}: {
  controls: EditorDisclosureControl;
}) {
  const t = useI18n();
  const label = controls.collapsed ? t["Expand"]() : t["Collapse"]();
  return (
    <IconButton
      size="small"
      aria-expanded={!controls.collapsed}
      aria-label={label}
      tooltip={label}
      data-collapsed={String(controls.collapsed)}
      data-range-sync-exclude="true"
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={(event) => {
        event.stopPropagation();
        controls.toggle();
      }}
    >
      {controls.collapsed ? <ChevronRightIcon /> : <ChevronDownIcon />}
    </IconButton>
  );
}
