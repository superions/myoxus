import { z } from "zod";

export const workbenchViewIconNameSchema = z.enum([
  "trash",
  "allDocs",
  "collection",
  "tag",
  "doc", // refers to a doc whose mode is not yet being resolved
  "page",
  "edgeless",
  "journal",
  "attachment",
  "pdf",
  "ai",
  "inbox",
  "home",
]);

export const workbenchViewMetaSchema = z.object({
  id: z.string(),
  path: z
    .object({
      pathname: z.string().optional(),
      hash: z.string().optional(),
      search: z.string().optional(),
    })
    .optional(),
  // todo: move title/module to cached stated
  title: z.string().optional(),
  iconName: workbenchViewIconNameSchema.optional(),
});

export const workbenchMetaSchema = z.object({
  id: z.string(),
  serverId: z.string().nullable().optional(),
  activeViewIndex: z.number(),
  pinned: z.boolean().optional(),
  basename: z.string(),
  workspaceName: z.string().max(4096).optional(),
  views: z.array(workbenchViewMetaSchema),
});

export const tabViewsMetaSchema = z.object({
  activeWorkbenchId: z.string().optional(),
  workbenches: z.array(workbenchMetaSchema).prefault([]),
});

export const TabViewsMetaKey = "tabViewsMetaSchema";
export type TabViewsMetaSchema = z.infer<typeof tabViewsMetaSchema>;
export type WorkbenchMeta = z.infer<typeof workbenchMetaSchema>;
export type WorkbenchViewMeta = z.infer<typeof workbenchViewMetaSchema>;
export type WorkbenchViewModule = z.infer<typeof workbenchViewIconNameSchema>;

export const SpellCheckStateSchema = z.object({
  enabled: z.boolean().optional(),
});

export const SpellCheckStateKey = "spellCheckState" as const;
// oxlint-disable-next-line no-redeclare
export type SpellCheckStateSchema = z.infer<typeof SpellCheckStateSchema>;

export const MenubarStateKey = "menubarState" as const;
export const MenubarStateSchema = z.object({
  enabled: z.boolean().default(true),
  openOnLeftClick: z.boolean().default(false),
  minimizeToTray: z.boolean().default(false),
  closeToTray: z.boolean().default(false),
  startMinimized: z.boolean().default(false),
});

export type MenubarStateSchema = z.infer<typeof MenubarStateSchema>;

export const MeetingSettingsKey = "meetingSettings" as const;
export const MeetingSettingsSchema = z.object({
  // global meeting feature control
  enabled: z.boolean().default(false),

  // when recording is saved, where to create the recording block
  recordingSavingMode: z.enum(["new-doc", "journal-today"]).default("new-doc"),

  // whether to enable generation of summary for new meeting recordings
  autoTranscriptionSummary: z.boolean().default(false),

  // whether to enable generation of todo list for new meeting recordings
  autoTranscriptionTodo: z.boolean().default(false),

  // recording reactions to new meeting events
  recordingMode: z.enum(["none", "prompt", "auto-start"]).default("prompt"),
});

export type MeetingSettingsSchema = z.infer<typeof MeetingSettingsSchema>;

export const OnboardingStateKey = "onboardingState" as const;
export const OnboardingStateSchema = z.object({
  completed: z.boolean(),
});
export type OnboardingStateSchema = z.infer<typeof OnboardingStateSchema>;

export const MainWindowStateKey = "mainWindowState" as const;
export const MainWindowStateSchema = z.object({
  bounds: z.object({
    x: z.number().int().finite(),
    y: z.number().int().finite(),
    width: z.number().int().min(640),
    height: z.number().int().min(480),
  }),
  isMaximized: z.boolean(),
  isFullScreen: z.boolean(),
});
export type MainWindowStateSchema = z.infer<typeof MainWindowStateSchema>;
