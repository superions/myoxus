// SPDX-License-Identifier: AGPL-3.0-or-later

import { notify } from "@myoxus/ui-facade";
import type { ReactNode } from "react";

type AdminToastOptions = {
  description?: ReactNode;
};

function normalizeMessage(message: ReactNode, options?: AdminToastOptions) {
  return {
    title: message,
    message: options?.description,
  };
}

/**
 * Admin-local notification adapter for legacy call sites that still use the
 * concise `toast.success("...")` form. Product code must not import Sonner
 * directly; the UI facade owns the concrete notification renderer.
 */
export const adminToast = {
  success(message: ReactNode, options?: AdminToastOptions) {
    return notify.success(normalizeMessage(message, options));
  },
  error(message: ReactNode, options?: AdminToastOptions) {
    return notify.error(normalizeMessage(message, options));
  },
  warning(message: ReactNode, options?: AdminToastOptions) {
    return notify.warning(normalizeMessage(message, options));
  },
  dismiss(id?: string | number) {
    return notify.dismiss(id);
  },
};
