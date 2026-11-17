// SPDX-License-Identifier: AGPL-3.0-or-later

import { EventBlockComponent } from "./event-block.js";

export function effects() {
  customElements.define("myoxus-event", EventBlockComponent);
}
