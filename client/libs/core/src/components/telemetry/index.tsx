import { useUserPreferences } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import { enableAutoTrack, sentry, tracker } from "@myoxus/track";
import { useEffect } from "react";

export function Telemetry() {
  const { effectivePreferences } = useUserPreferences();
  const telemetryEnabled = effectivePreferences?.telemetryEnabled;

  useEffect(() => {
    // Preserve the conservative pre-DI decision until the active account's
    // server acknowledgement (or offline projection) is available.
    if (telemetryEnabled === undefined) {
      return;
    }
    if (!telemetryEnabled) {
      sentry.disable();
      tracker.opt_out_tracking();
      return;
    } else {
      sentry.enable();
      tracker.opt_in_tracking();
      return enableAutoTrack(document.body, tracker.track);
    }
  }, [telemetryEnabled]);

  return null;
}
