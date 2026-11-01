import { Subject } from "rxjs";
import type { RendererCloseRequest } from "@myoxus/desktop-api-contract";

import type { AuthenticationRequest } from "../windows-manager";

export const uiSubjects = {
  onBrandingUpdated$: new Subject<{ serverId: string }>(),
  onMaximized$: new Subject<boolean>(),
  onFullScreen$: new Subject<boolean>(),
  onToggleRightSidebar$: new Subject<string>(),
  tabGoToRequest$: new Subject<{ tabId: string; to: string }>(),
  authenticationRequest$: new Subject<AuthenticationRequest>(),
  // via menu -> close view (CMD+W)
  onCloseView$: new Subject<void>(),
  onCloseRequest$: new Subject<RendererCloseRequest>(),
  onCalendarReminderClick$: new Subject<{
    eventId: string;
    startDate: string;
  }>(),
};
