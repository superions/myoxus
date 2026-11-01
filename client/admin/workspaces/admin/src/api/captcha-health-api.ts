// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { adminFetch } from "../fetch-utils";

export function fetchCaptchaChallenge(): Promise<Response> {
  return adminFetch("/api/auth/challenge", {
    admin: {
      channel: "auth",
      operationName: "captchaChallengeHealth",
      invalidateOnAuthFailure: false,
    },
  });
}
