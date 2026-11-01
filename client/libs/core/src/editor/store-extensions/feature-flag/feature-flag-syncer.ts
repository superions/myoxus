import {
  type FeatureFlagService,
  MYOXUS_FLAGS,
} from "@myoxus/core/modules/feature-flag";
import { FeatureFlagService as BSFeatureFlagService } from "@virgultum/editor/shared/services";
import { type ExtensionType, StoreExtension } from "@virgultum/editor/store";

export function getFeatureFlagSyncer(
  featureFlagService: FeatureFlagService,
): ExtensionType {
  class FeatureFlagSyncer extends StoreExtension {
    static override key = "feature-flag-syncer";

    override loaded() {
      const bsFeatureFlagService = this.store.get(BSFeatureFlagService);
      Object.entries(MYOXUS_FLAGS).forEach(([key, flag]) => {
        if (flag.category === "virgultum") {
          const value =
            featureFlagService.flags[key as keyof MYOXUS_FLAGS].value;
          if (value !== undefined) {
            bsFeatureFlagService.setFlag(flag.bsFlag, value);
          }
        }
      });
    }
  }

  return FeatureFlagSyncer;
}
