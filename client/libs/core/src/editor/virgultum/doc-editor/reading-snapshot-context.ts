// SPDX-License-Identifier: AGPL-3.0-or-later

import { createContext } from "react";

/** Detached readers hide edit chrome without changing a diagram's stored mode. */
export const ReadingSnapshotContext = createContext(false);
