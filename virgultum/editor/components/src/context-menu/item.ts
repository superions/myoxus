import { SignalWatcher, WithDisposable } from "@virgultum/global/lit";
import { ShadowlessElement } from "@virgultum/std";
import { property } from "lit/decorators.js";

import type { Menu } from "./menu.js";

export abstract class MenuItem extends SignalWatcher(
  WithDisposable(ShadowlessElement),
) {
  @property({ attribute: false })
  accessor menu!: Menu;
}
