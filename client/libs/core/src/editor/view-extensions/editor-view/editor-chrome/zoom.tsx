// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useI18n } from "@myoxus/i18n";
import { MinusIcon, PlusIcon, ViewBarIcon } from "@myoxus/icons/react";
import { Button, Group, IconButton, Tooltip } from "@myoxus/ui-facade";
import type { EditorZoomControls } from "@virgultum/editor/shared/services";
import { useSyncExternalStore } from "react";

export function EditorZoom({ controls }: { controls: EditorZoomControls }) {
  const { zoom, locked, visible } = useSyncExternalStore(
    controls.subscribe,
    controls.getSnapshot,
  );
  const t = useI18n();
  if (!visible) return null;
  const percentage = new Intl.NumberFormat(t.language, {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(zoom);
  return (
    <Group
      role="group"
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <IconButton
        icon={<ViewBarIcon />}
        tooltip={t["com.myoxus.editor.zoom.fit-to-screen"]()}
        disabled={locked}
        onClick={controls.fit}
      />
      <IconButton
        icon={<MinusIcon />}
        tooltip={t["Zoom out"]()}
        disabled={locked}
        onClick={() => controls.step(-1)}
      />
      <Tooltip content={t["com.myoxus.keyboardShortcuts.zoomTo100"]()}>
        <Button
          aria-label={t["com.myoxus.keyboardShortcuts.zoomTo100"]()}
          disabled={locked}
          onClick={() => controls.setZoom(1)}
        >
          {percentage}
        </Button>
      </Tooltip>
      <IconButton
        icon={<PlusIcon />}
        tooltip={t["Zoom in"]()}
        disabled={locked}
        onClick={() => controls.step(1)}
      />
    </Group>
  );
}
