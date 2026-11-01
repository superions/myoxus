import { NotificationProvider } from "@virgultum/shared/services";
import { type BlockStdScope } from "@virgultum/std";

function notify(std: BlockStdScope, title: string, message: string) {
  const notification = std.getOptional(NotificationProvider);

  // The Lit toast fallback (`@virgultum/components/toast`) was removed in
  // P-NOTIF-08: every consumer of this fork renders inside the React
  // shell, where `NotificationProvider` is always registered. If a
  // caller ever lands here without a provider, the call is a silent
  // no-op — there is no longer a standalone renderer to fall back to.
  if (!notification) {
    return;
  }

  notification.notifyWithUndoAction({
    title,
    message,
    accent: "info",
    duration: 10 * 1000,
  });
}

export function notifyLinkedDocSwitchedToCard(std: BlockStdScope) {
  notify(
    std,
    "View Updated",
    "The alias modification has disabled sync. The embed has been updated to a card view.",
  );
}

export function notifyLinkedDocSwitchedToEmbed(std: BlockStdScope) {
  notify(
    std,
    "Embed View Restored",
    "Custom alias removed. The linked doc now displays the original title and description.",
  );
}

export function notifyLinkedDocClearedAliases(std: BlockStdScope) {
  notify(
    std,
    "Reset successful",
    `Card view has been restored to original doc title and description. All custom aliases have been removed.`,
  );
}
