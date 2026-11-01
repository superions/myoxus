import type { Signal } from "@preact/signals-core";
import { createIdentifier } from "@virgultum/global/di";
import type { DeepPartial } from "@virgultum/global/utils";
import type { ExtensionType } from "@virgultum/store";
import { z } from "zod";

import { NodePropsSchema } from "../utils/zod-schema.js";

export const GeneralSettingSchema = z
  .object({
    edgelessScrollZoom: z.boolean().default(false),
    edgelessDisableScheduleUpdate: z.boolean().default(false),
    docCanvasPreferView: z
      .enum(["myoxus:embed-linked-doc", "myoxus:embed-synced-doc"])
      .default("myoxus:embed-synced-doc"),
  })
  .merge(NodePropsSchema);

export type EditorSetting = z.infer<typeof GeneralSettingSchema>;

export interface EditorSettingService {
  setting$: Signal<DeepPartial<EditorSetting>>;
  set?: (
    key: keyof EditorSetting,
    value: EditorSetting[keyof EditorSetting],
  ) => void;
}

export const EditorSettingProvider = createIdentifier<EditorSettingService>(
  "MyoxusEditorSettingProvider",
);

export function EditorSettingExtension(
  service: EditorSettingService,
): ExtensionType {
  return {
    setup: (di) => {
      di.override(EditorSettingProvider, () => service);
    },
  };
}
