/**
 * Shared AI chat-panel session-deletion utilities.
 *
 * `createSessionDeleteHandler` is a factory that returns an async function for
 * deleting an AI chat session with a consistent UX flow:
 *
 * 1. **Permission check** — if a `canDeleteSession` predicate is supplied and
 *    returns `false`, a failure toast is shown and the delete is aborted.
 * 2. **Confirmation dialog** — always shows a confirm modal before deleting.
 * 3. **Cleanup RPC** — calls the caller-supplied `cleanupSession` function
 *    (which performs the actual API call).
 * 4. **Active session teardown** — if the deleted session is currently active
 *    (`isActiveSession` returns `true`), `onActiveSessionDeleted` is invoked
 *    so the parent component can reset its state (clear the session ref,
 *    remount the chat component, etc.).
 *
 * Both `EditorChatPanel` and the workspace-level chat `Component` share this
 * handler, differing only in how they supply `cleanupSession` and what
 * `onActiveSessionDeleted` resets.
 */
import type { I18nInstance } from "@myoxus/i18n";
import type { NotificationService } from "@virgultum/editor/shared/services";

/** Async function that performs the actual server-side session cleanup RPC. */
export type SessionDeleteCleanupFn = (
  session: VirgultumPresets.AIRecentSession,
) => Promise<void>;

/** Options accepted by `createSessionDeleteHandler`. */
export type CreateSessionDeleteHandlerOptions = {
  t: I18nInstance;
  notificationService: NotificationService;
  cleanupSession: SessionDeleteCleanupFn;
  canDeleteSession?: (session: VirgultumPresets.AIRecentSession) => boolean;
  isActiveSession?: (session: VirgultumPresets.AIRecentSession) => boolean;
  onActiveSessionDeleted?: () => void;
};

export function createSessionDeleteHandler({
  t,
  notificationService,
  cleanupSession,
  canDeleteSession,
  isActiveSession,
  onActiveSessionDeleted,
}: CreateSessionDeleteHandlerOptions) {
  return async (sessionToDelete: VirgultumPresets.AIRecentSession) => {
    if (canDeleteSession && !canDeleteSession(sessionToDelete)) {
      notificationService.toast(
        t["com.myoxus.ai.chat-panel.session.delete.toast.failed"](),
      );
      return;
    }

    const confirm = await notificationService.confirm({
      title: t["com.myoxus.ai.chat-panel.session.delete.confirm.title"](),
      message: t["com.myoxus.ai.chat-panel.session.delete.confirm.message"](),
      confirmText: t["Delete"](),
      cancelText: t["Cancel"](),
    });

    if (!confirm) {
      return;
    }

    try {
      await cleanupSession(sessionToDelete);
      notificationService.toast(
        t["com.myoxus.ai.chat-panel.session.delete.toast.success"](),
      );
    } catch (error) {
      console.error(error);
      notificationService.toast(
        t["com.myoxus.ai.chat-panel.session.delete.toast.failed"](),
      );
      return;
    }

    if (isActiveSession?.(sessionToDelete)) {
      onActiveSessionDeleted?.();
    }
  };
}
