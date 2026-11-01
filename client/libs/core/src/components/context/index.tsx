import { ThemeProvider } from "@myoxus/core/components/theme-provider";
import {
  ConfirmModalProvider,
  PromptModalProvider,
  ProviderComposer,
} from "@myoxus/ui-facade";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { type createStore, Provider } from "jotai";
import { type PropsWithChildren, useMemo } from "react";

import { useImageAntialiasing } from "../hooks/use-image-antialiasing";

export type MyoxusContextProps = PropsWithChildren<{
  store?: ReturnType<typeof createStore>;
}>;

export function MyoxusContext(props: MyoxusContextProps) {
  useImageAntialiasing();
  return (
    <ProviderComposer
      contexts={useMemo(
        () =>
          [
            <Provider key="JotaiProvider" store={props.store} />,
            <ThemeProvider key="ThemeProvider" />,
            <MyoxusUIProvider key="MyoxusUIProvider" />,
            <ConfirmModalProvider key="ConfirmModalProvider" />,
            <PromptModalProvider key="PromptModalProvider" />,
          ].filter(Boolean),
        [props.store],
      )}
    >
      {props.children}
    </ProviderComposer>
  );
}
