// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useI18n } from "@myoxus/i18n";
import { AuthNotice } from "@myoxus/ui-facade";

import type { AuthContext } from ".";

export function AuthContextNotice({
  authContext,
}: {
  authContext?: AuthContext;
}) {
  const t = useI18n();

  if (authContext !== "admin") {
    return null;
  }

  return (
    <AuthNotice data-testid="auth-context-notice">
      {t["admin.auth.context.admin"]()}
    </AuthNotice>
  );
}
