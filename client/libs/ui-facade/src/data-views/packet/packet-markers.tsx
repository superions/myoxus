// SPDX-License-Identifier: AGPL-3.0-or-later

import { Group } from "@mantine/core";
import type { ReactNode } from "react";
/** Anchored marker content is supplied by the owning editor, never flattened to strings. */
export function PacketMarkers({ children }: { children: ReactNode }) {
  return children ? <Group>{children}</Group> : null;
}
