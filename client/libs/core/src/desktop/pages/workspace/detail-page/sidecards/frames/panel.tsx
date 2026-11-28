// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { EditorFrameNavigator } from "@myoxus/core/editor/view-extensions/editor-view/editor-chrome/frame-navigator";
import { useI18n } from "@myoxus/i18n";
import { PresentationIcon, SettingsIcon } from "@myoxus/icons/react";
import {
  Button,
  Divider,
  Group,
  IconButton,
  MyoxusText,
  Popover,
  PopoverContent,
  PopoverTarget,
  SettingsSwitchRow,
  Stack,
} from "@myoxus/ui-facade";
import { FrameNavigatorController } from "@virgultum/editor/fragments/frame-panel";
import type { EditorHost } from "@virgultum/editor/std";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

const FRAME_FIT_PADDING = [20, 20, 20, 20] as const;

/** Desktop Frames sidecard backed directly by {@link FrameNavigatorController}. */
export const EditorFramePanel = ({ editor }: { editor: EditorHost | null }) => {
  const t = useI18n();
  const [settingsOpen, setSettingsOpen] = useState(false);

  const controller = useMemo(
    () =>
      new FrameNavigatorController(editor, {
        fitPadding: FRAME_FIT_PADDING,
      }),
    // Keep controller identity stable across mode switches; `setHost` updates it below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    controller.setHost(editor);
  }, [controller, editor]);

  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
  );
  const { settings } = state;

  const labels = useMemo(
    () => ({
      allFramesSettings: t["com.myoxus.sidebar.frame.all-frames-settings"](),
      presentation: t["com.myoxus.sidebar.frame.presentation"](),
      previewSettings: t["com.myoxus.sidebar.frame.preview-settings"](),
      fillScreen: t["com.myoxus.sidebar.frame.fill-screen"](),
      playbackSettings: t["com.myoxus.sidebar.frame.playback-settings"](),
      darkBackground: t["com.myoxus.sidebar.frame.dark-background"](),
      hideToolbar: t["com.myoxus.sidebar.frame.hide-toolbar"](),
      emptyPlaceholder: t["com.myoxus.sidebar.frame.empty-placeholder"](),
    }),
    [t],
  );

  return (
    <Stack h="100%" mih={0} w="100%" data-myoxus-ui-role="frame-panel-root">
      <Group justify="flex-end" data-myoxus-ui-role="frame-panel-actions">
        <Popover
          opened={settingsOpen}
          onChange={setSettingsOpen}
          position="bottom-start"
        >
          <PopoverTarget>
            <IconButton
              aria-label={labels.allFramesSettings}
              data-testid="context-tool-settings-button"
              tooltip={settingsOpen ? undefined : labels.allFramesSettings}
              tooltipOptions={{ side: "bottom" }}
              onClick={() => setSettingsOpen((open) => !open)}
            >
              <SettingsIcon />
            </IconButton>
          </PopoverTarget>
          <PopoverContent>
            <Stack>
              <MyoxusText
                component="span"
                fallbackSlot="body-small"
                tone="secondary"
                typographySlot="caption"
              >
                {labels.previewSettings}
              </MyoxusText>
              <SettingsSwitchRow
                checked={settings.fillScreen}
                label={labels.fillScreen}
                onCheckedChange={(checked) =>
                  controller.setSetting("fillScreen", checked)
                }
              />
              <Divider />
              <MyoxusText
                component="span"
                fallbackSlot="body-small"
                tone="secondary"
                typographySlot="caption"
              >
                {labels.playbackSettings}
              </MyoxusText>
              <SettingsSwitchRow
                checked={settings.darkBackground}
                label={labels.darkBackground}
                onCheckedChange={(checked) =>
                  controller.setSetting("darkBackground", checked)
                }
              />
              <SettingsSwitchRow
                checked={settings.hideToolbar}
                label={labels.hideToolbar}
                onCheckedChange={(checked) =>
                  controller.setSetting("hideToolbar", checked)
                }
              />
            </Stack>
          </PopoverContent>
        </Popover>
        <Button
          data-testid="context-presentation-button"
          prefix={<PresentationIcon />}
          onClick={controller.enterPresentationMode}
        >
          {labels.presentation}
        </Button>
      </Group>
      <EditorFrameNavigator
        controller={controller}
        emptyLabel={labels.emptyPlaceholder}
      />
    </Stack>
  );
};
