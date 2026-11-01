import { toReactNode } from "@myoxus/lit-react";
import { I18n } from "@myoxus/i18n";
import {
  type ConfirmModalProps,
  Input,
  type MyoxusNotification,
  notify,
  type useConfirmModal,
} from "@myoxus/ui-facade";
import {
  NotificationExtension,
  type NotificationService,
} from "@virgultum/editor/shared/services";

export class NotificationServiceImpl implements NotificationService {
  constructor(
    private readonly closeConfirmModal: () => void,
    private readonly openConfirmModal: (props: ConfirmModalProps) => void,
  ) {}

  notifyMarkdownImportDiagnostics: NotificationService["notifyMarkdownImportDiagnostics"] =
    ({
      unresolvedReferences,
      unsupportedReferences,
      unsupportedAnnotations,
      normalizedAnnotations,
      unsupportedCallouts,
      unsupportedMath,
      normalizedEndnotes,
    }) => {
      if (unresolvedReferences || unsupportedReferences)
        notify.warning({
          title:
            I18n["com.myoxus.import.markdown.reference-diagnostics.title"](),
          message: I18n[
            "com.myoxus.import.markdown.reference-diagnostics.message"
          ]({
            unresolved: String(unresolvedReferences),
            unsupported: String(unsupportedReferences),
          }),
        });
      if (unsupportedAnnotations || normalizedAnnotations)
        notify.warning({
          title: I18n["com.myoxus.markdown.annotation-diagnostics.title"](),
          message: I18n["com.myoxus.markdown.annotation-diagnostics.message"]({
            unsupported: String(unsupportedAnnotations ?? 0),
            normalized: String(normalizedAnnotations ?? 0),
          }),
        });
      if (unsupportedCallouts)
        notify.warning({
          message: I18n["com.myoxus.markdown.callout-diagnostics"]({
            count: String(unsupportedCallouts),
          }),
        });
      if (unsupportedMath)
        notify.warning({
          message: I18n["com.myoxus.markdown.math-diagnostics"]({
            count: String(unsupportedMath),
          }),
        });
      if (normalizedEndnotes)
        notify.warning({
          message: I18n["com.myoxus.markdown.endnote-diagnostics"]({
            count: String(normalizedEndnotes),
          }),
        });
    };

  confirm = async ({
    title,
    message,
    confirmText,
    cancelText,
    abort,
  }: Parameters<NotificationService["confirm"]>[0]) => {
    return new Promise<boolean>((resolve) => {
      this.openConfirmModal({
        title: toReactNode(title),
        description: toReactNode(message),
        confirmText,
        confirmButtonOptions: {
          variant: "primary",
        },
        cancelText,
        onConfirm: () => {
          resolve(true);
        },
        onCancel: () => {
          resolve(false);
        },
      });
      abort?.addEventListener("abort", () => {
        resolve(false);
        this.closeConfirmModal();
      });
    });
  };

  prompt = async ({
    title,
    message,
    confirmText,
    placeholder,
    cancelText,
    autofill,
    abort,
  }: Parameters<NotificationService["prompt"]>[0]) => {
    return new Promise<string | null>((resolve) => {
      let value = autofill || "";
      const description = (
        <div>
          <span style={{ marginBottom: 12 }}>{toReactNode(message)}</span>
          <Input
            autoSelect={true}
            placeholder={placeholder}
            defaultValue={value}
            onChange={(e) => (value = e)}
          />
        </div>
      );
      this.openConfirmModal({
        title: toReactNode(title),
        description: description,
        confirmText: confirmText ?? "Confirm",
        confirmButtonOptions: {
          variant: "primary",
        },
        cancelText: cancelText ?? "Cancel",
        onConfirm: () => {
          resolve(value);
        },
        onCancel: () => {
          resolve(null);
        },
        autoFocusConfirm: false,
      });
      abort?.addEventListener("abort", () => {
        resolve(null);
        this.closeConfirmModal();
      });
    });
  };

  /**
   * Legacy `toast(message)` from the Lit-side editor bridge. After the
   * P-NOTIF-08 slice this routes through the Facade Mantine bridge, so
   * the editor's transient notifications share the same store and
   * theme as the rest of the React shell. The optional `portal`
   * argument is intentionally ignored: the global Mantine portal in
   * `MyoxusUIProvider` owns the only valid mount point.
   */
  toast = (
    message: string,
    options?: { duration?: number; portal?: HTMLElement },
  ) => {
    notify(
      { title: toReactNode(message) },
      { duration: options?.duration ?? 2500 },
    );
  };

  notify = (notification: Parameters<NotificationService["notify"]>[0]) => {
    const accentToNotify = {
      error: notify.error,
      success: notify.success,
      warning: notify.warning,
      info: notify,
    };

    const fn = accentToNotify[notification.accent || "info"];
    if (!fn) {
      throw new Error("Invalid notification accent");
    }

    const toMyoxusNotificationActions = (
      actions: (typeof notification)["actions"],
    ): MyoxusNotification["actions"] => {
      if (!actions) return undefined;

      return actions.map(({ label, onClick, key }) => {
        return {
          key,
          label: toReactNode(label),
          onClick,
        };
      });
    };

    const toastId = fn(
      {
        title: toReactNode(notification.title),
        message: toReactNode(notification.message),
        actions: toMyoxusNotificationActions(notification.actions),
        onDismiss: notification.onClose,
      },
      // Pass `duration` only when explicitly provided so the Facade bridge
      // default (5000ms) applies for editor notifications. `duration: 0`
      // still maps to `autoClose: false` (sticky) at the bridge; the
      // previous `duration || 0` made every editor notification sticky.
      notification.duration === undefined
        ? undefined
        : { duration: notification.duration },
    );

    notification.abort?.addEventListener("abort", () => {
      notify.dismiss(toastId);
    });
  };

  notifyWithUndoAction = (
    options: Parameters<NotificationService["notifyWithUndoAction"]>[0],
  ) => {
    this.notify(options);
  };
}

export function patchNotificationService({
  closeConfirmModal,
  openConfirmModal,
}: ReturnType<typeof useConfirmModal>) {
  const notificationService = new NotificationServiceImpl(
    closeConfirmModal,
    openConfirmModal,
  );
  return NotificationExtension(notificationService);
}
