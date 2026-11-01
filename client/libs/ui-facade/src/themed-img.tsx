// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type CSSProperties,
  forwardRef,
  type ImgHTMLAttributes,
  type Ref,
  useSyncExternalStore,
} from "react";

type ResolvedDomTheme = "dark" | "light";

function readResolvedDomTheme(): ResolvedDomTheme {
  if (typeof document === "undefined") return "light";

  const explicitTheme = document.documentElement.dataset.theme;
  if (explicitTheme === "dark" || explicitTheme === "light") {
    return explicitTheme;
  }

  if (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: dark)").matches
  ) {
    return "dark";
  }

  return "light";
}

function subscribeResolvedDomTheme(listener: () => void) {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => {};
  }

  const mediaQuery = window.matchMedia?.("(prefers-color-scheme: dark)");
  mediaQuery?.addEventListener("change", listener);

  const observer =
    typeof MutationObserver === "undefined"
      ? null
      : new MutationObserver(listener);
  observer?.observe(document.documentElement, {
    attributeFilter: ["data-theme"],
  });

  return () => {
    mediaQuery?.removeEventListener("change", listener);
    observer?.disconnect();
  };
}

export function useResolvedDomTheme(): ResolvedDomTheme {
  return useSyncExternalStore<ResolvedDomTheme>(
    subscribeResolvedDomTheme,
    readResolvedDomTheme,
    () => "light",
  );
}

export type ThemedImgProps = Omit<
  ImgHTMLAttributes<HTMLImageElement>,
  "src"
> & {
  lightSrc: string;
  darkSrc?: string;
  fluid?: boolean;
};

const fluidThemedImgStyle: CSSProperties = {
  display: "block",
  height: "auto",
  maxWidth: "100%",
  width: "100%",
};

export const ThemedImg = forwardRef(function ThemedImg(
  { lightSrc, darkSrc, fluid = false, style, ...attrs }: ThemedImgProps,
  ref: Ref<HTMLImageElement>,
) {
  const resolvedTheme = useResolvedDomTheme();
  const src = resolvedTheme === "dark" && darkSrc ? darkSrc : lightSrc;
  return (
    <img
      ref={ref}
      alt=""
      src={src}
      loading="lazy"
      style={fluid ? { ...fluidThemedImgStyle, ...style } : style}
      {...attrs}
    />
  );
});
