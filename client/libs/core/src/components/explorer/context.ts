// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { LiveData } from "@myoxus/infra";
import { createContext } from "react";

import type { ExplorerDisplayPreference } from "./types";

const DEFAULT_EXPLORER_PREFERENCE: ExplorerDisplayPreference = {
  view: "list",
  previewSize: "normal",
  displayProperties: [
    "system:createdAt",
    "system:updatedAt",
    "system:createdBy",
    "system:tags",
  ],
  orderBy: {
    type: "system",
    key: "updatedAt",
    desc: true,
  },
  groupBy: {
    type: "system",
    key: "updatedAt",
  },
  showDocIcon: true,
  showDocPreview: true,
  quickFavorite: true,
  showDragHandle: true,
  showMoreOperation: true,
};

export type DocExplorerContextType = {
  groups$: LiveData<Array<{ key: string; items: string[] }>>;
  collapsedGroups$: LiveData<string[]>;
  selectMode$?: LiveData<boolean>;
  selectedDocIds$: LiveData<string[]>;
  /** Typed `document:<id>` / `database:<id>` identities for mixed surfaces. */
  selectedItemKeys$: LiveData<string[]>;
  prevCheckAnchorId$?: LiveData<string | null>;
  displayPreference$: LiveData<ExplorerDisplayPreference>;
} & {
  [K in keyof ExplorerDisplayPreference as `${K}$`]: LiveData<
    ExplorerDisplayPreference[K]
  >;
};

export const DocExplorerContext = createContext<DocExplorerContextType>(
  {} as DocExplorerContextType,
);

export const createDocExplorerContext = (
  initialState?: ExplorerDisplayPreference,
) => {
  const displayPreference$ = new LiveData<ExplorerDisplayPreference>({
    ...DEFAULT_EXPLORER_PREFERENCE,
    ...initialState,
  });

  const select = <K extends keyof ExplorerDisplayPreference>(key: K) =>
    displayPreference$.selector((pref) => pref[key]);

  return {
    groups$: new LiveData<Array<{ key: string; items: string[] }>>([]),
    collapsedGroups$: new LiveData<string[]>([]),
    selectMode$: new LiveData<boolean>(false),
    selectedDocIds$: new LiveData<string[]>([]),
    selectedItemKeys$: new LiveData<string[]>([]),
    prevCheckAnchorId$: new LiveData<string | null>(null),
    displayPreference$,
    showDragHandle$: select("showDragHandle"),
    view$: select("view"),
    previewSize$: select("previewSize"),
    groupBy$: select("groupBy"),
    orderBy$: select("orderBy"),
    displayProperties$: select("displayProperties"),
    showDocIcon$: select("showDocIcon"),
    showDocPreview$: select("showDocPreview"),
    quickFavorite$: select("quickFavorite"),
    quickSelect$: select("quickSelect"),
    quickSplit$: select("quickSplit"),
    quickTrash$: select("quickTrash"),
    quickTab$: select("quickTab"),
    showMoreOperation$: select("showMoreOperation"),
    quickDeletePermanently$: select("quickDeletePermanently"),
    quickRestore$: select("quickRestore"),
  } satisfies DocExplorerContextType;
};
