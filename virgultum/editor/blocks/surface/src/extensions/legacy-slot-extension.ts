import { createIdentifier } from "@virgultum/global/di";
import type { FrameBlockModel } from "@virgultum/model";
import type { ExtensionType } from "@virgultum/store";
import { Subject } from "rxjs";
export const EdgelessLegacySlotIdentifier = createIdentifier<{
  readonlyUpdated: Subject<boolean>;
  navigatorSettingUpdated: Subject<{
    hideToolbar?: boolean;
    blackBackground?: boolean;
    fillScreen?: boolean;
  }>;
  navigatorFrameChanged: Subject<FrameBlockModel>;
  fullScreenToggled: Subject<void>;

  elementResizeStart: Subject<void>;
  elementResizeEnd: Subject<void>;
  toggleNoteSlicer: Subject<void>;

  toolbarLocked: Subject<boolean>;
}>("MyoxusEdgelessLegacySlotService");

export const EdgelessLegacySlotExtension: ExtensionType = {
  setup: (di) => {
    di.addImpl(EdgelessLegacySlotIdentifier, () => ({
      readonlyUpdated: new Subject<boolean>(),
      navigatorSettingUpdated: new Subject<{
        hideToolbar?: boolean;
        blackBackground?: boolean;
        fillScreen?: boolean;
      }>(),
      navigatorFrameChanged: new Subject<FrameBlockModel>(),
      fullScreenToggled: new Subject(),
      elementResizeStart: new Subject(),
      elementResizeEnd: new Subject(),
      toggleNoteSlicer: new Subject(),
      toolbarLocked: new Subject<boolean>(),
    }));
  },
};
