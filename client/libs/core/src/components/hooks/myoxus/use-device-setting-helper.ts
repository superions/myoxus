// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { type DeviceSetting, deviceSettingAtom } from "@myoxus/infra";
import { useAtom } from "jotai";
import { useCallback, useMemo } from "react";

export function useDeviceSettingHelper() {
  const [deviceSettings, setDeviceSettings] = useAtom(deviceSettingAtom);

  const updateSettings = useCallback(
    <K extends keyof DeviceSetting>(key: K, value: DeviceSetting[K]) => {
      setDeviceSettings((previous) => ({ ...previous, [key]: value }));
    },
    [setDeviceSettings],
  );

  return useMemo(
    () => ({ deviceSettings, updateSettings }),
    [deviceSettings, updateSettings],
  );
}
