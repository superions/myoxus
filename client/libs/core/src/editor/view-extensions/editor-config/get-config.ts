import {
  createCustomToolbarExtension,
  createToolbarMoreMenuConfig,
} from "@myoxus/core/editor/view-extensions/editor-config/toolbar";
import { EditorSettingService } from "@myoxus/core/modules/editor-setting";
import { WorkspaceServerService } from "@myoxus/core/modules/server";
import type { FrameworkProvider } from "@myoxus/infra";
import { ClipboardConfigExtension } from "@virgultum/editor/blocks/root";
import { ToolbarMoreMenuConfigExtension } from "@virgultum/editor/components/toolbar";
import { EditorSettingExtension } from "@virgultum/editor/shared/services";
import type { ExtensionType } from "@virgultum/store";

export function getEditorConfigExtension(
  framework: FrameworkProvider,
): ExtensionType[] {
  const editorSettingService = framework.get(EditorSettingService);
  const workspaceServerService = framework.get(WorkspaceServerService);
  const baseUrl = workspaceServerService.server?.baseUrl ?? location.origin;
  const httpFallback =
    workspaceServerService.server?.config$.value?.clipboardHttpFallback ??
    false;

  return [
    EditorSettingExtension({
      setting$: editorSettingService.editorSetting.settingSignal,
      set: (k, v) => editorSettingService.editorSetting.set(k, v),
    }),
    ToolbarMoreMenuConfigExtension(createToolbarMoreMenuConfig(framework)),
    createCustomToolbarExtension(
      editorSettingService.editorSetting,
      baseUrl,
      framework,
    ),
    ClipboardConfigExtension({ httpFallback }),
  ].flat();
}
