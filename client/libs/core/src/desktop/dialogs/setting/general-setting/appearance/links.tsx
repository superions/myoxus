import {
  OpenInAppService,
  OpenLinkMode,
} from "@myoxus/core/modules/open-in-app";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import { useMemo } from "react";

import { FormSelect } from "../../primitives";

export const OpenInAppLinksMenu = () => {
  const t = useI18n();
  const openInAppService = useService(OpenInAppService);
  const currentOpenInAppMode = useLiveData(openInAppService.openLinkMode$);

  const options = useMemo(
    () =>
      Object.values(OpenLinkMode).map((mode) => ({
        label:
          t.t(`com.myoxus.setting.appearance.open-in-app.${mode}`) ||
          `com.myoxus.setting.appearance.open-in-app.${mode}`,
        value: mode,
      })),
    [t],
  );

  return (
    <FormSelect
      aria-label={t["com.myoxus.setting.appearance.open-in-app"]()}
      data={options}
      value={currentOpenInAppMode}
      onChange={(value) =>
        openInAppService.setOpenLinkMode(value as OpenLinkMode)
      }
    />
  );
};
