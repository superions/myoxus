// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

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
  const currentMode = useLiveData(openInAppService.openLinkMode$);

  const options = useMemo(
    () =>
      Object.values(OpenLinkMode).map((mode) => {
        const key = `com.myoxus.setting.appearance.open-in-app.${mode}`;
        return {
          label: t.t(key) || key,
          value: mode,
        };
      }),
    [t],
  );

  return (
    <FormSelect
      aria-label={t["com.myoxus.setting.appearance.open-in-app"]()}
      data={options}
      value={currentMode}
      onChange={(value) =>
        openInAppService.setOpenLinkMode(value as OpenLinkMode)
      }
    />
  );
};
