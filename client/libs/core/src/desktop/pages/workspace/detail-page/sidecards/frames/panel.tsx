import { useI18n } from "@myoxus/i18n";
import { PresentationIcon, SettingsIcon } from "@myoxus/icons/react";
import {
  Box,
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
import {
  type NavigatorMode,
  PresentTool,
} from "@virgultum/editor/blocks/frame";
import { EdgelessLegacySlotIdentifier } from "@virgultum/editor/blocks/surface";
import { FramePanel } from "@virgultum/editor/fragments/frame-panel";
import {
  DocModeProvider,
  EditPropsStore,
} from "@virgultum/editor/shared/services";
import type { EditorHost } from "@virgultum/editor/std";
import { GfxControllerIdentifier } from "@virgultum/editor/std/gfx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type FrameNavigatorSettings = {
  darkBackground: boolean;
  fillScreen: boolean;
  hideToolbar: boolean;
};

type DisposableLike = {
  dispose?: () => void;
  unsubscribe?: () => void;
};

const disposeSubscription = (subscription: DisposableLike | undefined) => {
  subscription?.dispose?.();
  subscription?.unsubscribe?.();
};

const readNavigatorSettings = (
  editor: EditorHost | null,
): FrameNavigatorSettings => {
  if (!editor) {
    return {
      darkBackground: true,
      fillScreen: false,
      hideToolbar: false,
    };
  }

  const editPropsStore = editor.std.get(EditPropsStore);
  return {
    darkBackground: editPropsStore.getStorage("presentBlackBackground") ?? true,
    fillScreen: editPropsStore.getStorage("presentFillScreen") ?? false,
    hideToolbar: editPropsStore.getStorage("presentHideToolbar") ?? false,
  };
};

export const EditorFramePanel = ({ editor }: { editor: EditorHost | null }) => {
  const t = useI18n();
  const framePanelRef = useRef<FramePanel | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [navigatorSettings, setNavigatorSettings] =
    useState<FrameNavigatorSettings>(() => readNavigatorSettings(editor));
  const labels = useMemo(
    () => ({
      allFrames: t["com.myoxus.sidebar.frame.all-frames"](),
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

  const setNavigatorSetting = useCallback(
    <Key extends keyof FrameNavigatorSettings>(
      key: Key,
      value: FrameNavigatorSettings[Key],
    ) => {
      if (!editor) return;

      setNavigatorSettings((settings) => ({
        ...settings,
        [key]: value,
      }));

      const editPropsStore = editor.std.get(EditPropsStore);
      const slots = editor.std.get(EdgelessLegacySlotIdentifier);
      if (key === "fillScreen") {
        editPropsStore.setStorage("presentFillScreen", value);
        slots.navigatorSettingUpdated.next({ fillScreen: value });
      } else if (key === "darkBackground") {
        editPropsStore.setStorage("presentBlackBackground", value);
        slots.navigatorSettingUpdated.next({ blackBackground: value });
      } else {
        editPropsStore.setStorage("presentHideToolbar", value);
        slots.navigatorSettingUpdated.next({ hideToolbar: value });
      }
    },
    [editor],
  );

  const enterPresentationMode = useCallback(() => {
    if (!editor) return;

    const docModeProvider = editor.std.get(DocModeProvider);
    if (docModeProvider.getEditorMode() !== "edgeless") {
      docModeProvider.setEditorMode("edgeless");
    }

    const navigatorMode: NavigatorMode = navigatorSettings.fillScreen
      ? "fill"
      : "fit";
    window.setTimeout(() => {
      editor.std.get(GfxControllerIdentifier).tool.setTool(PresentTool, {
        mode: navigatorMode,
      });
    }, 100);
  }, [editor, navigatorSettings.fillScreen]);

  const onRefChange = useCallback(
    (container: HTMLDivElement | null) => {
      if (editor && container && container.children.length === 0) {
        framePanelRef.current = new FramePanel();
        framePanelRef.current.host = editor;
        framePanelRef.current.hideHeader = true;
        framePanelRef.current.fitPadding = [20, 20, 20, 20];
        framePanelRef.current.labels = labels;
        container.append(framePanelRef.current);
      }
    },
    [editor, labels],
  );

  useEffect(() => {
    setNavigatorSettings(readNavigatorSettings(editor));

    if (!editor) return;

    const slots = editor.std.get(EdgelessLegacySlotIdentifier);
    const subscription = slots.navigatorSettingUpdated.subscribe(
      ({ blackBackground, fillScreen, hideToolbar }) => {
        setNavigatorSettings((settings) => ({
          darkBackground: blackBackground ?? settings.darkBackground,
          fillScreen: fillScreen ?? settings.fillScreen,
          hideToolbar: hideToolbar ?? settings.hideToolbar,
        }));
      },
    ) as DisposableLike;

    return () => disposeSubscription(subscription);
  }, [editor]);

  useEffect(() => {
    if (editor && framePanelRef.current) {
      framePanelRef.current.host = editor;
    }
  }, [editor]);

  useEffect(() => {
    if (framePanelRef.current) {
      framePanelRef.current.labels = labels;
    }
  }, [labels]);

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
                checked={navigatorSettings.fillScreen}
                label={labels.fillScreen}
                onCheckedChange={(checked) =>
                  setNavigatorSetting("fillScreen", checked)
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
                checked={navigatorSettings.darkBackground}
                label={labels.darkBackground}
                onCheckedChange={(checked) =>
                  setNavigatorSetting("darkBackground", checked)
                }
              />
              <SettingsSwitchRow
                checked={navigatorSettings.hideToolbar}
                label={labels.hideToolbar}
                onCheckedChange={(checked) =>
                  setNavigatorSetting("hideToolbar", checked)
                }
              />
            </Stack>
          </PopoverContent>
        </Popover>
        <Button
          data-testid="context-presentation-button"
          prefix={<PresentationIcon />}
          onClick={enterPresentationMode}
        >
          {labels.presentation}
        </Button>
      </Group>
      <Box
        ref={onRefChange}
        flex={1}
        h="100%"
        mih={0}
        w="100%"
        data-myoxus-ui-role="editor-frame-panel-mount"
      />
    </Stack>
  );
};
