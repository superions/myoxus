import { Entity, LiveData } from "@myoxus/infra";
import { map } from "rxjs";

import type { AppSidebarState } from "../providers/storage";

enum APP_SIDEBAR_STATE {
  OPEN = "open",
  WIDTH = "width",
}

export class AppSidebar extends Entity {
  constructor(private readonly appSidebarState: AppSidebarState) {
    super();
  }

  open$ = LiveData.from(
    this.appSidebarState
      .watch<boolean>(APP_SIDEBAR_STATE.OPEN)
      .pipe(map((value) => value ?? true)),
    this.appSidebarState.get<boolean>(APP_SIDEBAR_STATE.OPEN) ?? true,
  );

  width$ = LiveData.from(
    this.appSidebarState
      .watch<number>(APP_SIDEBAR_STATE.WIDTH)
      .pipe(map((value) => value ?? 248)),
    this.appSidebarState.get<number>(APP_SIDEBAR_STATE.WIDTH) ?? 248,
  );

  resizing$ = new LiveData<boolean>(false);

  getCachedAppSidebarOpenState = () => {
    return this.appSidebarState.get<boolean>(APP_SIDEBAR_STATE.OPEN);
  };

  toggleSidebar = () => {
    this.setOpen(!this.open$.value);
  };

  setOpen = (open: boolean) => {
    this.appSidebarState.set(APP_SIDEBAR_STATE.OPEN, open);
    return;
  };

  setResizing = (resizing: boolean) => {
    this.resizing$.next(resizing);
  };

  setWidth = (width: number) => {
    this.appSidebarState.set(APP_SIDEBAR_STATE.WIDTH, width);
  };
}
