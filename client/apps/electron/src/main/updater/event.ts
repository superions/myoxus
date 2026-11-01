import type { UpdateMeta, UpdaterState } from "@myoxus/desktop-api-contract";
import { BehaviorSubject } from "rxjs";
import type { MainEventImplementations } from "../type";

export type { UpdateMeta } from "@myoxus/desktop-api-contract";
export const updaterSubjects = {
  updateAvailable$: new BehaviorSubject<UpdateMeta | null>(null),
  updateReady$: new BehaviorSubject<UpdateMeta | null>(null),
  downloadProgress$: new BehaviorSubject<number | null>(null),
  state$: new BehaviorSubject<UpdaterState>({
    availability: { state: "disabled", reason: "development" },
    phase: "idle",
    available: null,
    ready: null,
    progress: null,
  }),
};

export function updateState(patch: Partial<UpdaterState>) {
  const next = { ...updaterSubjects.state$.value, ...patch };
  updaterSubjects.state$.next(next);
  if (updaterSubjects.updateAvailable$.value !== next.available)
    updaterSubjects.updateAvailable$.next(next.available);
  if (updaterSubjects.updateReady$.value !== next.ready)
    updaterSubjects.updateReady$.next(next.ready);
  if (updaterSubjects.downloadProgress$.value !== next.progress)
    updaterSubjects.downloadProgress$.next(next.progress);
}

export const updaterEvents = {
  onUpdateAvailable: (fn: (meta: UpdateMeta | null) => void) => {
    const sub = updaterSubjects.updateAvailable$.subscribe(fn);
    return () => sub.unsubscribe();
  },
  onUpdateReady: (fn: (meta: UpdateMeta | null) => void) => {
    const sub = updaterSubjects.updateReady$.subscribe(fn);
    return () => sub.unsubscribe();
  },
  onDownloadProgress: (fn: (progress: number | null) => void) => {
    const sub = updaterSubjects.downloadProgress$.subscribe(fn);
    return () => sub.unsubscribe();
  },
  onStateChange: (fn: (state: UpdaterState) => void) => {
    const sub = updaterSubjects.state$.subscribe(fn);
    return () => sub.unsubscribe();
  },
} satisfies MainEventImplementations["updater"];
