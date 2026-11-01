// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  OnboardingStateKey,
  OnboardingStateSchema,
} from "../shared-state-schema";
import type { DesktopStateStorage } from "../shared-storage/storage";

export const FreshOnboardingState: OnboardingStateSchema = {
  completed: false,
};

export function readOnboardingState(
  storage: DesktopStateStorage,
  onInvalid: () => void = () => undefined,
): OnboardingStateSchema {
  const stored = storage.get(OnboardingStateKey);
  const parsed = OnboardingStateSchema.safeParse(stored);
  if (parsed.success) return parsed.data;
  if (stored !== undefined) onInvalid();
  return FreshOnboardingState;
}

export async function completeOnboarding(storage: DesktopStateStorage) {
  storage.set(OnboardingStateKey, { completed: true });
  await storage.flush();
}

export async function applyOnboardingEnvironment(
  storage: DesktopStateStorage,
  value: string | undefined,
) {
  if (value === "1") await completeOnboarding(storage);
}
