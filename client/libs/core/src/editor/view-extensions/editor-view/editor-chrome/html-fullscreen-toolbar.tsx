// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useState } from "react";
import { useI18n } from "@myoxus/i18n";
import {
  CopyIcon,
  DoneIcon,
  ExpandCloseIcon,
  SettingsIcon,
} from "@myoxus/icons/react";
import {
  Box,
  Divider,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTarget,
  Switch,
  ToolbarSurface,
} from "@myoxus/ui-facade";
import type { EditorHtmlFullscreenControls } from "@virgultum/editor/shared/services";

export function EditorHtmlFullscreenToolbar({
  controls: c,
}: {
  controls: EditorHtmlFullscreenControls;
}) {
  const t = useI18n();
  const [portalTarget, setPortalTarget] = useState<HTMLDivElement | null>(null);
  const tooltipOptions = { portalProps: { target: portalTarget ?? undefined } };
  return (
    <Box ref={setPortalTarget}>
      <Popover
        opened={c.settingsOpen}
        onChange={c.setSettingsOpen}
        position="top-end"
        withinPortal={false}
      >
        <ToolbarSurface
          compact
          role="toolbar"
          aria-label="HTML"
          data-testid="html-fullscreen-toolbar"
        >
          <IconButton
            tooltipOptions={tooltipOptions}
            icon={<ExpandCloseIcon />}
            tooltip={t["com.myoxus.peek-view-controls.close"]()}
            onClick={c.close}
          />
          <PopoverTarget>
            <IconButton
              tooltipOptions={tooltipOptions}
              icon={<SettingsIcon />}
              tooltip={t["com.myoxus.sidebar.outline.settings"]()}
              aria-expanded={c.settingsOpen}
              onClick={() => c.setSettingsOpen(!c.settingsOpen)}
            />
          </PopoverTarget>
          <Divider orientation="vertical" />
          <IconButton
            tooltipOptions={tooltipOptions}
            icon={c.copied ? <DoneIcon /> : <CopyIcon />}
            tooltip={c.copied ? t["Copied to clipboard"]() : t.Copy()}
            onClick={c.copy}
          />
        </ToolbarSurface>
        {/* Stay inside fullscreen, but outside the compact toolbar's scroll viewport. */}
        <PopoverContent>
          <Switch checked={c.autoHide} onChange={c.setAutoHide}>
            {t["com.myoxus.editor.toolbar.hide-toolbar"]()}
          </Switch>
        </PopoverContent>
      </Popover>
    </Box>
  );
}
