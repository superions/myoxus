// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Editor-side transient-notification bridge.
 *
 * Virgultum code historically rendered toasts through a Lit fallback
 * (`@virgultum/components/toast`) that mounted its own container into the
 * editor viewport. After the P-NOTIF-08 slice that renderer is gone —
 * every transient notification in the editor flows through the Facade
 * Mantine portal via `NotificationProvider`.
 *
 * `editorToast(host, message)` is a thin helper that preserves the old
 * call-site shape (`toast(host, msg)`) while delegating to the registered
 * `NotificationService`. When the editor is mounted inside the Myoxus
 * React shell, `NotificationProvider` is supplied by
 * `NotificationServiceImpl` and ultimately calls `notify` from
 * `@myoxus/ui-facade` (which routes to `@mantine/notifications`). When the
 * editor is mounted without a NotificationService — which is the legacy
 * Lit-fallback case — the call is a silent no-op: there is no longer a
 * standalone Lit renderer to fall back to, because every consumer of
 * this fork renders inside the React shell.
 */
import type { EditorHost } from "@virgultum/std";

import {
  EditorI18nProvider,
  resolveEditorMessage,
  type EditorI18nMessage,
} from "../services/index.js";
import { NotificationProvider } from "../services/notification-service.js";

export function editorToast(
  host: EditorHost,
  message: string | EditorI18nMessage,
  duration?: number,
): void {
  const resolvedMessage =
    typeof message === "string"
      ? message
      : resolveEditorMessage(
          message,
          host.std.getOptional(EditorI18nProvider) ?? undefined,
        );
  host.std
    .getOptional(NotificationProvider)
    ?.toast(resolvedMessage, { duration });
}
