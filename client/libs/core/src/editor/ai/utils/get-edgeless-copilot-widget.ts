// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { EditorHost } from "@virgultum/editor/std";

import type { EdgelessCopilotWidget } from "../widgets/edgeless-copilot";
import { MYOXUS_EDGELESS_COPILOT_WIDGET } from "../widgets/edgeless-copilot/constant";

export function getEdgelessCopilotWidget(
  host: EditorHost,
): EdgelessCopilotWidget {
  const rootId = host.store.root?.id as string;
  return host.view.getWidget(
    MYOXUS_EDGELESS_COPILOT_WIDGET,
    rootId,
  ) as EdgelessCopilotWidget;
}
