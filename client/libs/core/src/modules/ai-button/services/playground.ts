import { Service } from "@myoxus/infra";
import {
  createSignalFromObservable,
  type Signal,
} from "@virgultum/editor/shared/utils";

import type { FeatureFlagService } from "../../feature-flag";

export class AIPlaygroundService extends Service {
  constructor(private readonly featureFlagService: FeatureFlagService) {
    super();

    const { signal: visible, cleanup: visibleCleanup } =
      createSignalFromObservable<boolean | undefined>(
        this._visible$,
        undefined,
      );
    this.visible = visible;
    this.disposables.push(visibleCleanup);
  }

  visible: Signal<boolean | undefined>;

  private readonly _visible$ =
    this.featureFlagService.flags.enable_ai_playground.$;
}
