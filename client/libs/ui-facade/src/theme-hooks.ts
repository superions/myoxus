// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import { type MyoxusTheme, darkTheme, lightTheme } from "@myoxus/theme";
import { useResolvedDomTheme } from "./themed-img";
import { useLayoutEffect } from "react";

export function useThemeValue(key: keyof Omit<MyoxusTheme, "editorMode">) {
  const resolvedTheme = useResolvedDomTheme();
  return resolvedTheme === "dark" ? darkTheme[key] : lightTheme[key];
}

let themeColorMetaElement: HTMLMetaElement | null = null;

function getThemeColorMetaElement() {
  if (themeColorMetaElement) return themeColorMetaElement;

  const exists = document.querySelector('meta[name="theme-color"]');
  if (exists) {
    themeColorMetaElement = exists as HTMLMetaElement;
    return themeColorMetaElement;
  }

  themeColorMetaElement = document.createElement("meta");
  themeColorMetaElement.name = "theme-color";
  document.head.append(themeColorMetaElement);
  return themeColorMetaElement;
}

export function useThemeColorMeta(color: string) {
  useLayoutEffect(() => {
    const meta = getThemeColorMetaElement();
    const old = meta.content;
    meta.content = color;

    const oldBg = document.documentElement.style.backgroundColor;
    document.documentElement.style.backgroundColor = color;

    return () => {
      meta.content = old;
      document.documentElement.style.backgroundColor = oldBg;
    };
  }, [color]);
}

export function useThemeColor(...args: Parameters<typeof useThemeValue>) {
  useThemeColorMeta(useThemeValue(...args));
}
