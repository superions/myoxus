// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

export function joinClassName(...parts: Array<string | undefined>) {
  return parts.filter(Boolean).join(" ");
}
