// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import { createIdentifier } from "@virgultum/editor/global/di";
import type { ExtensionType } from "@virgultum/editor/store";
import type { ReactNode } from "react";
import type { TemplateResult } from "lit";

/** The existing editor React tree owns theme, portals and disposal; AI stays client-only. */
export const AIWidgetUI =
  createIdentifier<(view: ReactNode) => TemplateResult>("MyoxusAIWidgetUI");
export function aiWidgetUI(
  render: (view: ReactNode) => TemplateResult,
): ExtensionType {
  return { setup: (di) => di.addImpl(AIWidgetUI, () => render) };
}
