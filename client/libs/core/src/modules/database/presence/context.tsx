// SPDX-License-Identifier: AGPL-3.0-or-later

import { createContext, type ReactNode, useContext } from "react";

import type { UseDatabasePresenceResult } from "./use-database-presence";

const DatabasePresenceContext = createContext<UseDatabasePresenceResult | null>(
  null,
);

export function DatabasePresenceProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: UseDatabasePresenceResult;
}) {
  return (
    <DatabasePresenceContext.Provider value={value}>
      {children}
    </DatabasePresenceContext.Provider>
  );
}

export function useDatabasePresenceContext(): UseDatabasePresenceResult {
  const value = useContext(DatabasePresenceContext);
  if (!value) {
    throw new Error("Database presence must render below its shared provider.");
  }
  return value;
}
