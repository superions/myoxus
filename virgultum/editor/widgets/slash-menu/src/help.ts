import type { SlashMenuTooltip } from "./types";
import { editorMessage } from "@virgultum/shared/services";

export const slashMenuToolTips: Record<string, SlashMenuTooltip> = {
  "action-today": {
    caption: editorMessage("com.myoxus.common.calendar.today", "Today"),
  },

  "action-tomorrow": {
    caption: editorMessage("com.myoxus.tomorrow", "Tomorrow"),
  },

  "action-yesterday": {
    caption: editorMessage("com.myoxus.yesterday", "Yesterday"),
  },

  "action-now": {
    caption: editorMessage("com.myoxus.time.now", "Now"),
  },

  "action-move-up": {
    caption: editorMessage("com.myoxus.editor.slash.move-up", "Move Up"),
  },

  "action-move-down": {
    caption: editorMessage("com.myoxus.editor.slash.move-down", "Move Down"),
  },

  "action-copy": {
    caption: editorMessage("Copy", "Copy"),
  },

  "action-delete": {
    caption: editorMessage("Delete", "Delete"),
  },
};
