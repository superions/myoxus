// SPDX-License-Identifier: AGPL-3.0-or-later

import { createContext, type ReactNode, useContext } from "react";

const DashboardEditChromeContext = createContext<ReactNode>(null);

export const DashboardEditChromeProvider = DashboardEditChromeContext.Provider;

export const useDashboardEditChrome = () =>
  useContext(DashboardEditChromeContext);
