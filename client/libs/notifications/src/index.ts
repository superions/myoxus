// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `@myoxus/notifications` is a thin compatibility/export boundary for
 * Mantine notifications.
 *
 * It does not own rendering, timers or its own queue. The actual
 * notification portal is mounted exactly once inside
 * `@myoxus/ui-facade`'s `MyoxusUIProvider` via Mantine's `<Notifications />`
 * component, and the public API surface for product code lives on the
 * Facade's `notify` / `notify.success` / `notify.error` /
 * `notify.warning` / `notify.dismiss` exports.
 *
 * This package re-exports the Mantine notification store so that product
 * code which needs direct access to the underlying store (`notifications`,
 * `notificationsStore`) can import it without taking a dependency on
 * `@mantine/notifications` directly. After P-NOTIF-09 the deprecated
 * `MyoxusToaster`/`toast()` path is gone, so the `dismissNotification`,
 * `subscribeNotifications` and `NotificationRecord` shims have been
 * removed as well — callers should use the Facade's `notify` exports.
 */

export type {
  NotificationData,
  NotificationsState,
} from "@mantine/notifications";
export { notifications, notificationsStore } from "@mantine/notifications";
