// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";

interface PasswordLimits {
  minLength: number;
  maxLength: number;
}

export interface AdminCredentials {
  name: string;
  email: string;
  password: string;
}

export function validateAdminCredentials(
  email: string,
  password: string,
  limits: PasswordLimits,
  setInvalidEmail?: (invalid: boolean) => void,
  setInvalidPassword?: (invalid: boolean) => void,
) {
  const emailAccepted = z.string().trim().email().safeParse(email).success;
  const passwordAccepted =
    password.length >= limits.minLength && password.length <= limits.maxLength;

  setInvalidEmail?.(!emailAccepted);
  setInvalidPassword?.(!passwordAccepted);

  return emailAccepted && passwordAccepted;
}
