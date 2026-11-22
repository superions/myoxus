// SPDX-License-Identifier: AGPL-3.0-or-later
import { createContext } from "react";

/** The desktop app opts in inside its native storage setup, not in auxiliary windows. */
export const DesktopPageRendererContext = createContext(false);
