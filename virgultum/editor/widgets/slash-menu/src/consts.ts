export const MYOXUS_SLASH_MENU_WIDGET = "myoxus-slash-menu-widget";
export const MYOXUS_SLASH_MENU_TRIGGER_KEY = "/";
export const MYOXUS_SLASH_MENU_ALTERNATE_TRIGGER_KEYS = ["、"] as const;
export const MYOXUS_SLASH_MENU_TRIGGER_KEYS = [
  MYOXUS_SLASH_MENU_TRIGGER_KEY,
  ...MYOXUS_SLASH_MENU_ALTERNATE_TRIGGER_KEYS,
] as const;

export function findSlashMenuTriggerSuffix(text: string): string | undefined {
  return MYOXUS_SLASH_MENU_TRIGGER_KEYS.find((triggerKey) =>
    text.endsWith(triggerKey),
  );
}

export function isSlashMenuTriggerInput(text: string): boolean {
  return MYOXUS_SLASH_MENU_TRIGGER_KEYS.some((triggerKey) =>
    text.includes(triggerKey),
  );
}
