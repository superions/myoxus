// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// Boot services use notifications before mounting the provider. Retain the
// shared CSS owner here to preserve the former barrel evaluation order.
import "./styles";

import {
  type ReactNode,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  createElement,
} from "react";
import {
  type MyoxusNotificationTheme,
  myoxusThemeToMantineColor,
} from "./feedback";
import { Group, Button as MantineButton } from "@mantine/core";
import { notifications as mantineNotifications } from "@mantine/notifications";
import { I18n } from "@myoxus/i18n";

export type MyoxusNotificationStyle = "normal" | "information" | "alert";

export type MyoxusNotificationAction = {
  key?: string;
  label: ReactNode;
  onClick?: () => void | Promise<void>;
  /**
   * Kept from the former notification contract. Existing settings flows use it
   * for navigation actions that must keep the toast visible after the click.
   */
  autoClose?: boolean;
  buttonProps?: ButtonHTMLAttributes<HTMLButtonElement>;
};

export type MyoxusNotification = {
  style?: MyoxusNotificationStyle | string;
  theme?: MyoxusNotificationTheme;
  borderColor?: string;
  background?: string;
  foreground?: string;
  alignMessage?: "title" | "icon" | string;
  actions?: MyoxusNotificationAction[];
  rootAttrs?: HTMLAttributes<HTMLDivElement>;
  thumb?: ReactNode;
  title?: ReactNode;
  message?: ReactNode;
  error?: unknown;
  icon?: ReactNode;
  iconColor?: string;
  onDismiss?: () => void;
};

export type MyoxusNotificationOptions = {
  id?: string | number;
  duration?: number;
  /** Native portal placement for persistent feedback that would otherwise
   * obscure a surface's controls. Omission preserves the provider default. */
  position?: Parameters<typeof mantineNotifications.show>[0]["position"];
};

type CustomNotificationRenderer = (props: {
  onDismiss: () => void;
}) => ReactNode;

function normalizeNotification(
  notification: MyoxusNotification | Error | ReactNode,
): MyoxusNotification {
  // `Error` instances expose a `.message` property through their prototype
  // chain, so a generic `"message" in error` check would incorrectly
  // classify an Error as a `MyoxusNotification`. Detect `Error` first.
  if (notification instanceof Error) {
    return { error: notification };
  }
  if (
    notification &&
    typeof notification === "object" &&
    ("title" in notification ||
      "message" in notification ||
      "icon" in notification ||
      "theme" in notification ||
      "style" in notification ||
      "error" in notification ||
      "actions" in notification ||
      "thumb" in notification)
  ) {
    return notification as MyoxusNotification;
  }
  return { title: notification as ReactNode };
}

function notificationErrorText(error: unknown): ReactNode {
  if (!error) return null;
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "object" && error && "message" in error) {
    const message = (error as { message?: unknown }).message;
    return typeof message === "string" ? message : String(message);
  }
  return String(error);
}

function buildMyoxusNotificationActions(
  input: MyoxusNotification,
  id: string,
): ReactNode {
  if (!input.actions?.length) return null;

  return (
    <Group
      data-myoxus-ui-role="notification-actions"
      justify="flex-end"
      gap="xs"
      mt="xs"
      wrap="wrap"
    >
      {input.actions.map((action, index) => {
        const {
          className: _className,
          style: _style,
          type,
          ...buttonProps
        } = action.buttonProps ?? {};
        const labelKey = action.key ?? `action-${index}`;
        return (
          <MantineButton
            {...buttonProps}
            component="button"
            data-myoxus-ui-role={
              ((buttonProps as Record<string, unknown>)[
                "data-myoxus-ui-role"
              ] as string | undefined) ?? "button:compact"
            }
            data-testid={action.key}
            key={labelKey}
            onClick={() => {
              const result = action.onClick?.();
              if (result && typeof result === "object" && "catch" in result) {
                result.catch(console.error);
              }
              if (action.autoClose !== false) {
                mantineNotifications.hide(id);
              }
            }}
            size="xs"
            type={type ?? "button"}
            variant="filled"
          >
            {action.label}
          </MantineButton>
        );
      })}
    </Group>
  );
}

function buildMyoxusMantinePayload(
  input: MyoxusNotification,
  options: MyoxusNotificationOptions | undefined,
): {
  payload: Parameters<typeof mantineNotifications.show>[0];
  id: string;
} {
  const errorText = notificationErrorText(input.error);
  const normalized = normalizeNotification(input) as MyoxusNotification;
  const errorFromNormalized =
    errorText ?? notificationErrorText(normalized.error);
  const title = normalized.title ?? errorFromNormalized ?? undefined;
  const message = normalized.message;
  const id =
    options?.id !== undefined && options.id !== null
      ? String(options.id)
      : `myoxus-notification-${Math.random().toString(36).slice(2, 10)}`;
  const autoClose =
    options?.duration === 0 ? false : (options?.duration ?? 5000);

  // Mantine renders `title` above `message`/`children` with its own
  // typography slot, so we forward `title` directly. The caller-supplied
  // description and any action buttons are composed into the message
  // body in a single `div` so the action row stays visually grouped with
  // the description.
  const messageBody: ReactNode = (
    <>
      {message}
      {buildMyoxusNotificationActions(normalized, id)}
    </>
  );

  return {
    id,
    payload: {
      id,
      title,
      message: messageBody,
      color: myoxusThemeToMantineColor(normalized.theme),
      icon: normalized.icon ?? undefined,
      autoClose,
      position: options?.position,
      closeButtonProps: {
        "aria-label": I18n["com.myoxus.toast.dismiss"](),
      },
      onClose: normalized.onDismiss
        ? () => normalized.onDismiss?.()
        : undefined,
    },
  };
}

/**
 * Show a transient notification.
 *
 * Routes through `@mantine/notifications`. The Mantine `<Notifications />`
 * portal is mounted exactly once by `MyoxusUIProvider`; product code must
 * not import `@mantine/notifications` directly and must not call
 * `notifications.show(...)` directly.
 *
 * **Theme colors:** callers pass semantic theme names
 * (`"info" | "success" | "warning" | "error"` or undefined). The bridge
 * maps them to the Mantine theme color scales `myoxusInfo`, `myoxusSuccess`,
 * `myoxusWarning`, `myoxusInfo`; every stop of those scales is a
 * unversioned theme reference, so Light/Dark switching is theme-driven and no
 * per-call color value is required.
 *
 * **Auto-close:** `options.duration === 0` (or `notify.dismiss(id)`) keeps
 * the notification on screen; any other value (or no value) auto-closes
 * after `duration` ms, default 5000.
 *
 * **Error normalization:** an `Error` instance (or any object with a
 * `message` field) is rendered with its `error.message || error.name`
 * text as the title.
 *
 * **Actions:** Mantine 9 has no native `actions` slot. Caller-provided
 * `actions` are rendered as compact buttons inside the notification
 * message body. Each button calls its `onClick` and then hides the
 * notification unless `action.autoClose === false` (used by navigation
 * actions such as the workspace-backup "Open" button).
 *
 * **Dropped legacy fields:** `rootAttrs`, `style`, `alignMessage`,
 * `borderColor`, `background`, `foreground`, `iconColor` are accepted in
 * the input shape for source compatibility during the migration but are
 * not rendered. They will be removed from the public type by P-NOTIF-09.
 *
 * **id:** the returned notification id can be passed to `notify.dismiss(id)`
 * to close it manually.
 *
 * @example
 *   notify.success({ title: "Saved" });
 *   notify.error(new Error("boom"));
 *   notify({ title: "Link copied", actions: [{ label: "Open", onClick }] });
 */
export const notify = Object.assign(
  (
    notification: MyoxusNotification | Error | ReactNode,
    options?: MyoxusNotificationOptions,
  ) => {
    const normalized = normalizeNotification(notification);
    const { id, payload } = buildMyoxusMantinePayload(normalized, options);
    mantineNotifications.show(payload);
    return id;
  },
  {
    success(
      notification: MyoxusNotification | Error | ReactNode,
      options?: MyoxusNotificationOptions,
    ) {
      const normalized = normalizeNotification(notification);
      const { id, payload } = buildMyoxusMantinePayload(
        { ...normalized, theme: "success" },
        options,
      );
      mantineNotifications.show(payload);
      return id;
    },
    error(
      notification: MyoxusNotification | Error | ReactNode,
      options?: MyoxusNotificationOptions,
    ) {
      const normalized = normalizeNotification(notification);
      const { id, payload } = buildMyoxusMantinePayload(
        { ...normalized, theme: "error" },
        options,
      );
      mantineNotifications.show(payload);
      return id;
    },
    warning(
      notification: MyoxusNotification | Error | ReactNode,
      options?: MyoxusNotificationOptions,
    ) {
      const normalized = normalizeNotification(notification);
      const { id, payload } = buildMyoxusMantinePayload(
        { ...normalized, theme: "warning" },
        options,
      );
      mantineNotifications.show(payload);
      return id;
    },
    custom(
      Component: CustomNotificationRenderer,
      options?: MyoxusNotificationOptions,
    ) {
      const id =
        options?.id !== undefined && options.id !== null
          ? String(options.id)
          : `myoxus-notification-${Math.random().toString(36).slice(2, 10)}`;
      mantineNotifications.show({
        id,
        position: options?.position,
        message: createElement(Component, {
          onDismiss: () => mantineNotifications.hide(id),
        }),
        autoClose:
          options?.duration === 0 ? false : (options?.duration ?? 5000),
      });
      return id;
    },
    dismiss(id?: string | number) {
      if (id === undefined) {
        mantineNotifications.clean();
        return;
      }
      mantineNotifications.hide(String(id));
    },
  },
);

export const MyoxusNotification = notify;
