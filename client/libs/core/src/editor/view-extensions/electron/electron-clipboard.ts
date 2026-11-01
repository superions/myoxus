import { DesktopApiService } from "@myoxus/core/modules/desktop-api";
import type { FrameworkProvider } from "@myoxus/infra";
import { NativeClipboardExtension } from "@virgultum/editor/shared/services";

export function patchForClipboardInElectron(framework: FrameworkProvider) {
  const desktopApi = framework.get(DesktopApiService);
  return NativeClipboardExtension({
    copyAsPNG: desktopApi.handler.clipboard.copyAsPNG,
  });
}
