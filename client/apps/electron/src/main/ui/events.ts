import type { MainEventImplementations } from "../type";
import type { RendererCloseRequest } from "@myoxus/desktop-api-contract";
import {
  type AuthenticationRequest,
  onActiveTabChanged,
  onTabAction,
  onTabShellViewActiveChange,
  onTabsStatusChange,
  onTabViewsMetaChanged,
} from "../windows-manager";
import { uiSubjects } from "./subject";

/**
 * Events triggered by application menu
 */
export const uiEvents = {
  onBrandingUpdated: (fn: (payload: { serverId: string }) => void) => {
    const sub = uiSubjects.onBrandingUpdated$.subscribe(fn);
    return () => sub.unsubscribe();
  },
  onMaximized: (fn: (maximized: boolean) => void) => {
    const sub = uiSubjects.onMaximized$.subscribe(fn);
    return () => {
      sub.unsubscribe();
    };
  },
  onFullScreen: (fn: (fullScreen: boolean) => void) => {
    const sub = uiSubjects.onFullScreen$.subscribe(fn);
    return () => {
      sub.unsubscribe();
    };
  },
  onTabViewsMetaChanged,
  onTabAction,
  onToggleRightSidebar: (fn: (tabId: string) => void) => {
    const sub = uiSubjects.onToggleRightSidebar$.subscribe(fn);
    return () => {
      sub.unsubscribe();
    };
  },
  onTabsStatusChange,
  onActiveTabChanged,
  onTabGoToRequest: (fn: (opts: { tabId: string; to: string }) => void) => {
    const sub = uiSubjects.tabGoToRequest$.subscribe(fn);
    return () => {
      sub.unsubscribe();
    };
  },
  onTabShellViewActiveChange,
  onAuthenticationRequest: (fn: (state: AuthenticationRequest) => void) => {
    const sub = uiSubjects.authenticationRequest$.subscribe(fn);
    return () => {
      sub.unsubscribe();
    };
  },
  onCloseView: (fn: () => void) => {
    const sub = uiSubjects.onCloseView$.subscribe(fn);
    return () => {
      sub.unsubscribe();
    };
  },
  onCloseRequest: (fn: (request: RendererCloseRequest) => void) => {
    const sub = uiSubjects.onCloseRequest$.subscribe(fn);
    return () => sub.unsubscribe();
  },
  onCalendarReminderClick: (
    fn: (payload: { eventId: string; startDate: string }) => void,
  ) => {
    const sub = uiSubjects.onCalendarReminderClick$.subscribe(fn);
    return () => {
      sub.unsubscribe();
    };
  },
} satisfies MainEventImplementations["ui"];
