import type { FrameworkProvider } from "@myoxus/infra";
import { notify } from "@myoxus/ui-facade";
import type { Container } from "@virgultum/editor/global/di";
import {
  FileSizeLimitProvider,
  type IFileSizeLimitService,
} from "@virgultum/editor/shared/services";
import { Extension } from "@virgultum/editor/store";

export function patchFileSizeLimitExtension(_framework: FrameworkProvider) {
  class MyoxusFileSizeLimitService
    extends Extension
    implements IFileSizeLimitService
  {
    // 2GB
    maxFileSize = 2 * 1024 * 1024 * 1024;

    onOverFileSize() {
      notify.warning({
        title: "File too large",
        message: "The file exceeds the maximum allowed size (2 GB).",
      });
    }

    static override setup(di: Container) {
      di.override(FileSizeLimitProvider, MyoxusFileSizeLimitService);
    }
  }

  return MyoxusFileSizeLimitService;
}
