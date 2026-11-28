// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { SettingTab } from "@myoxus/core/modules/dialogs/constant";
import type { ReactElement } from "react";

export interface SettingSidebarItem<T extends SettingTab = SettingTab> {
  key: T;
  title: string;
  icon: ReactElement;
  testId: string;
  beta?: boolean;
}
