import { GeneralSettingSchema } from "@virgultum/editor/shared/services";
import { z } from "zod";

export const BSEditorSettingSchema = GeneralSettingSchema;

export type EdgelessDefaultTheme = "auto" | "dark" | "light" | "specified";

// These values are persisted Edgeless content text-size settings, not product
// layout geometry. Keep them centralized so Settings views do not carry local
// pixel-label enums that look like UI spacing or sizing constants.
export const edgelessTextSizeOptions = [16, 20, 24, 32, 40, 64] as const;

export const formatEdgelessTextSizeLabel = (size: number): string =>
  `${size}px`;

const MyoxusEditorSettingSchema = z.object({
  // Null follows the theme. Only an explicit pixel preference overrides it.
  fontSize: z.number().int().min(12).max(24).nullable().default(null),
  newDocDefaultMode: z.enum(["edgeless", "page", "ask"]).default("page"),
  fullWidthLayout: z.boolean().default(false),
  documentMetadataHeaderVisibility: z
    .record(z.string(), z.record(z.string(), z.boolean()))
    .prefault({}),
  edgelessDefaultTheme: z
    .enum(["specified", "dark", "light", "auto"])
    .default("specified"),
  openDocMode: z
    .enum([
      "open-in-active-view",
      "open-in-new-view",
      "open-in-new-tab",
      "open-in-center-peek",
    ])
    .default("open-in-active-view"),
  // linux only:
  enableMiddleClickPaste: z.boolean().default(false),
});

export const EditorSettingSchema = BSEditorSettingSchema.merge(
  MyoxusEditorSettingSchema,
);

// oxlint-disable-next-line no-redeclare
export type EditorSettingSchema = z.infer<typeof EditorSettingSchema>;
