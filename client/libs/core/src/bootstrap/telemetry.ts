import { readCachedTelemetryPreference } from "@myoxus/infra";
import { sentry, tracker } from "@myoxus/track";

tracker.init();
sentry.init();

if (typeof localStorage !== "undefined") {
  if (readCachedTelemetryPreference(localStorage) === false) {
    sentry.disable();
    tracker.opt_out_tracking();
  }
}
