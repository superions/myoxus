import { LiveData, Service } from "@myoxus/infra";
import {
  createSignalFromObservable,
  type Signal,
} from "@virgultum/editor/shared/utils";

import type { UserPreferencesService } from "../../server";

export class AIReasoningService extends Service {
  constructor(private readonly userPreferencesService: UserPreferencesService) {
    super();

    const { signal: enabled, cleanup: enabledCleanup } =
      createSignalFromObservable<boolean | undefined>(
        this._enabled$,
        undefined,
      );
    this.enabled = enabled;
    this.disposables.push(enabledCleanup);
  }

  enabled: Signal<boolean | undefined>;

  private readonly _enabled$ = LiveData.from(
    this.userPreferencesService.userPreferences$.map(
      (preferences) => preferences?.effectiveValues.aiReasoningEnabled,
    ),
    undefined,
  );

  setEnabled = (enabled: boolean) => {
    void this.userPreferencesService.update({ aiReasoningEnabled: enabled });
  };
}
