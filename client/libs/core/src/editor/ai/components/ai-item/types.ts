// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { MyoxusIconExportName } from "@myoxus/icons/names";
import type { DocMode } from "@virgultum/editor/model";
import type { Chain, EditorHost, InitCommandCtx } from "@virgultum/editor/std";
import type { ReactNode } from "react";

export interface AISubItemConfig {
  type: string;
  testId?: string;
  handler?: (host: EditorHost) => void;
}

export interface AIItemConfig {
  name: string;
  testId: string;
  icon?: MyoxusIconExportName | ReactNode;
  iconName?: MyoxusIconExportName;
  showWhen?: (
    chain: Chain<InitCommandCtx>,
    editorMode: DocMode,
    host: EditorHost,
  ) => boolean;
  subItem?: AISubItemConfig[];
  subItemOffset?: [number, number];
  handler?: (host: EditorHost) => void;
  beta?: boolean;
}

export interface AIItemGroupConfig {
  name?: string;
  testId?: string;
  items: AIItemConfig[];
}
