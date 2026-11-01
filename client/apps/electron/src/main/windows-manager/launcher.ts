import { logger } from "../logger";
import { globalStateStorage } from "../shared-storage/storage";
import { initAndShowMainWindow } from "./main-window";
import { getOrCreateOnboardingWindow } from "./onboarding";
import {
  applyOnboardingEnvironment,
  readOnboardingState,
} from "./onboarding-state";

/** Launch the single current onboarding or main-window state. */
export async function launch() {
  await applyOnboardingEnvironment(
    globalStateStorage,
    process.env.SKIP_ONBOARDING,
  );
  if (
    readOnboardingState(globalStateStorage, () =>
      logger.warn("ignoring invalid desktop onboarding state"),
    ).completed
  ) {
    await initAndShowMainWindow();
    return;
  }

  const onboarding = await getOrCreateOnboardingWindow();
  if (!onboarding.isVisible()) onboarding.show();
}
