// SPDX-License-Identifier: AGPL-3.0-or-later
import { ViewService } from "@myoxus/core/modules/workbench";
import { useLiveData, useService } from "@myoxus/infra";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type PropsWithChildren,
} from "react";
import type { HistorySelection } from "./history-selection";

const historyKeys = [
  "history",
  "snapshotId",
  "versionId",
  "historyMode",
] as const;
export type HistoryMode = "preview" | "changes";
export interface HistoryLocation {
  open: boolean;
  invalid: boolean;
  selection?: HistorySelection;
  mode: HistoryMode;
}

/** Read URL values as strings: a snapshot may exceed JavaScript's integer range. */
export function parseHistoryLocation(search: string): HistoryLocation {
  const params = new URLSearchParams(search);
  const open = params.has("history");
  const id = params.get("snapshotId");
  const versionId = params.get("versionId");
  const mode = params.get("historyMode");
  const invalid =
    open &&
    (params.get("history") !== "1" ||
      historyKeys.some((key) => params.getAll(key).length > 1) ||
      (id !== null &&
        (!/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n)) ||
      (versionId !== null &&
        (!id ||
          !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(versionId))) ||
      (mode !== null && mode !== "preview" && mode !== "changes"));
  return {
    open,
    invalid,
    mode: mode === "changes" ? "changes" : "preview",
    selection:
      open && !invalid && id
        ? { snapshotId: id, ...(versionId ? { versionId } : {}) }
        : undefined,
  };
}

/** Only history keys are owned here; document mode, links and hash survive. */
export function historySearch(
  search: string,
  next?: { selection?: HistorySelection; mode: HistoryMode },
) {
  const params = new URLSearchParams(search);
  for (const key of historyKeys) params.delete(key);
  if (next) {
    params.set("history", "1");
    params.set("historyMode", next.mode);
    if (next.selection) {
      params.set("snapshotId", next.selection.snapshotId);
      if (next.selection.versionId)
        params.set("versionId", next.selection.versionId);
    }
  }
  const result = params.toString();
  return result ? `?${result}` : "";
}

interface HistoryNavigation {
  state: HistoryLocation;
  open: (selection?: HistorySelection, opener?: HTMLElement | null) => void;
  close: () => void;
  select: (selection: HistorySelection) => void;
  setMode: (mode: HistoryMode) => void;
}
const Navigation = createContext<HistoryNavigation | null>(null);

/** One lifetime per document in one Workbench View; no global modal state. */
export function HistoryNavigationProvider({ children }: PropsWithChildren) {
  const view = useService(ViewService).view;
  const location = useLiveData(view.location$);
  const state = useMemo(
    () => parseHistoryLocation(location.search),
    [location.search],
  );
  const live = useRef(true);
  const opener = useRef<
    { element: HTMLElement; testId?: string; snapshotId?: string } | undefined
  >(undefined);
  const wasOpen = useRef(state.open);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const open = useCallback(
    (selection?: HistorySelection, trigger?: HTMLElement | null) => {
      if (!live.current) return;
      const element =
        trigger ??
        (document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null);
      if (element)
        opener.current = {
          element,
          testId: element.getAttribute("data-testid") ?? undefined,
          snapshotId: element.getAttribute("data-snapshot-id") ?? undefined,
        };
      const current = view.location$.value;
      const next = {
        ...current,
        search: historySearch(current.search, { selection, mode: "preview" }),
      };
      if (parseHistoryLocation(current.search).open) view.replace(next);
      else view.push(next);
    },
    [view],
  );
  const close = useCallback(() => {
    if (!live.current) return;
    const current = view.location$.value;
    view.push({ ...current, search: historySearch(current.search) });
  }, [view]);
  const replace = useCallback(
    (selection: HistorySelection | undefined, mode: HistoryMode) => {
      if (!live.current) return;
      const current = view.location$.value;
      if (!parseHistoryLocation(current.search).open) return;
      view.replace({
        ...current,
        search: historySearch(current.search, { selection, mode }),
      });
    },
    [view],
  );
  const select = useCallback(
    (selection: HistorySelection) => {
      replace(
        selection,
        parseHistoryLocation(view.location$.value.search).mode,
      );
    },
    [replace, view],
  );
  const setMode = useCallback(
    (mode: HistoryMode) => {
      replace(
        parseHistoryLocation(view.location$.value.search).selection,
        mode,
      );
    },
    [replace, view],
  );
  useEffect(() => {
    const returning = wasOpen.current && !state.open;
    wasOpen.current = state.open;
    if (!returning) return;
    // Islands mount the document header/body after this route transition. Resolve
    // the opening control again if its old document-mode node was unmounted.
    const frame = requestAnimationFrame(() => {
      const root = document.querySelector(
        `[data-workbench-view-id="${CSS.escape(view.id)}"]`,
      );
      const target = opener.current;
      let element = target?.element.isConnected ? target.element : undefined;
      if (!element && target?.testId) {
        const suffix = target.snapshotId
          ? `[data-snapshot-id="${CSS.escape(target.snapshotId)}"]`
          : "";
        element =
          root?.querySelector<HTMLElement>(
            `[data-testid="${CSS.escape(target.testId)}"]${suffix}`,
          ) ?? undefined;
      }
      element ??=
        root?.querySelector<HTMLElement>(
          '[data-testid="header-dropDownButton"]',
        ) ?? undefined;
      element ??=
        root?.querySelector<HTMLElement>(
          '[data-testid="workbench-view-header"] button',
        ) ?? undefined;
      element?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [state.open, view]);
  const value = useMemo(
    () => ({ state, open, close, select, setMode }),
    [state, open, close, select, setMode],
  );
  return <Navigation.Provider value={value}>{children}</Navigation.Provider>;
}

export function useHistoryNavigation() {
  const navigation = useContext(Navigation);
  if (!navigation)
    throw new Error("Document history requires its Workbench View scope");
  return navigation;
}
