// SPDX-License-Identifier: AGPL-3.0-or-later

import { createSpotlight, SpotlightRoot } from "@myoxus/ui-facade";
import {
  createContext,
  type PropsWithChildren,
  useEffect,
  useRef,
  useState,
} from "react";

export const QuickSearchSpotlightContext = createContext(false);

export interface QuickSearchModalProps {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
}

export const QuickSearchModal = ({
  onOpenChange,
  open,
  children,
}: PropsWithChildren<QuickSearchModalProps>) => {
  const openRef = useRef(open);
  openRef.current = open;

  const [spotlightInstance] = useState(() => {
    const instance = createSpotlight();
    if (open) {
      instance[1].open();
    }
    return instance;
  });
  const [store, actions] = spotlightInstance;

  useEffect(() => {
    if (open) {
      actions.open();
    } else {
      actions.close();
    }
  }, [actions, open]);

  return (
    <SpotlightRoot
      store={store}
      shortcut={null}
      clearQueryOnClose={false}
      closeOnActionTrigger={false}
      scrollable
      maxHeight={520}
      aria-label="Quick search"
      trapFocus
      returnFocus
      keepMounted={false}
      overlayProps={
        {
          "data-myoxus-ui-role": "command-palette-overlay",
        } as Record<string, unknown>
      }
      onSpotlightClose={() => {
        if (openRef.current) {
          onOpenChange?.(false);
        }
      }}
    >
      <QuickSearchSpotlightContext.Provider value={true}>
        {children}
      </QuickSearchSpotlightContext.Provider>
    </SpotlightRoot>
  );
};
