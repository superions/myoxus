// SPDX-License-Identifier: AGPL-3.0-or-later

import * as rootContract from "../src/index";
import {
  clientEventChannelManifest,
  clientHandlerChannelManifest,
  type MainClientHandlers,
} from "../src/index";

type HandlerManifest = typeof clientHandlerChannelManifest;
type EventManifest = typeof clientEventChannelManifest;

declare const uiWithoutMoveTab: Omit<HandlerManifest["ui"], "moveTab">;
const missingHandlerChannel: HandlerManifest = {
  ...clientHandlerChannelManifest,
  // @ts-expect-error A missing runtime channel must not satisfy the manifest.
  ui: uiWithoutMoveTab,
};

const additionalEventNamespace: EventManifest = {
  ...clientEventChannelManifest,
  // @ts-expect-error An additional namespace must not satisfy the manifest.
  invented: {},
};

// @ts-expect-error Handler argument drift must fail compilation.
const wrongMoveTabSignature: MainClientHandlers["ui"]["moveTab"] = async (
  from: number,
  to: number,
) => {
  void from;
  void to;
};

// @ts-expect-error Runtime bridge access is intentionally absent at the root.
rootContract.getDesktopBridge();

void missingHandlerChannel;
void additionalEventNamespace;
void wrongMoveTabSignature;
