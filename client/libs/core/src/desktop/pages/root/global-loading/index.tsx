import { globalLoadingEventsAtom } from "@myoxus/global-loading";
import { GlobalLoadingOverlay, Loading } from "@myoxus/ui-facade";
import { useAtomValue } from "jotai";
import { type ReactNode, useEffect, useState } from "react";

export function GlobalLoading(): ReactNode {
  const globalLoadingEvents = useAtomValue(globalLoadingEventsAtom);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (globalLoadingEvents.length) {
      setLoading(true);
    } else {
      setLoading(false);
    }
  }, [globalLoadingEvents]);

  if (!globalLoadingEvents.length) {
    return null;
  }
  return (
    <GlobalLoadingOverlay visible={loading}>
      <Loading />
    </GlobalLoadingOverlay>
  );
}
