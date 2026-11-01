import { useEffect } from "react";

import { useUserPreferences } from "./myoxus/use-user-preferences";

export function useImageAntialiasing() {
  const { effectivePreferences } = useUserPreferences();
  const imageAntialiasing = effectivePreferences?.imageAntialiasing ?? true;

  useEffect(() => {
    document.documentElement.dataset.imageAntialiasing = imageAntialiasing
      ? "on"
      : "off";
  }, [imageAntialiasing]);
}
