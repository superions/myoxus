// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect } from "react";

export function SharedSignInRedirect({ to }: { to: string }) {
  useEffect(() => {
    window.location.replace(to);
  }, [to]);

  return (
    <a data-testid="shared-sign-in-redirect" href={to}>
      {to}
    </a>
  );
}
