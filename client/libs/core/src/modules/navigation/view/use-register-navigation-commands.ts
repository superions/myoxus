import {
  PreconditionStrategy,
  registerMyoxusCommand,
} from "@myoxus/core/commands";
import { useService } from "@myoxus/infra";
import { track } from "@myoxus/track";
import { useEffect } from "react";

import { NavigatorService } from "../services/navigator";

export function useRegisterNavigationCommands() {
  const navigator = useService(NavigatorService).navigator;
  useEffect(() => {
    const unsubs: Array<() => void> = [];

    unsubs.push(
      registerMyoxusCommand({
        id: "myoxus:shortcut-history-go-back",
        category: "myoxus:general",
        preconditionStrategy: PreconditionStrategy.Never,
        icon: "none",
        label: "go back",
        keyBinding: {
          binding: "$mod+[",
        },
        run() {
          track.$.cmdk.general.goBack();

          navigator.back();
        },
      }),
    );
    unsubs.push(
      registerMyoxusCommand({
        id: "myoxus:shortcut-history-go-forward",
        category: "myoxus:general",
        preconditionStrategy: PreconditionStrategy.Never,
        icon: "none",
        label: "go forward",
        keyBinding: {
          binding: "$mod+]",
        },
        run() {
          track.$.cmdk.general.goForward();

          navigator.forward();
        },
      }),
    );

    return () => {
      unsubs.forEach((unsub) => unsub());
    };
  }, [navigator]);
}
