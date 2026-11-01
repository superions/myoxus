// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useI18n } from "@myoxus/i18n";
import { Button, SidebarVersionRow } from "@myoxus/ui-facade";

import { useServerConfig } from "../common";

export function ServerVersion() {
  const i18n = useI18n();
  const server = useServerConfig();

  if (server?.availableUpgrade) {
    const upgrade = server.availableUpgrade;
    const label = `${i18n.t("admin.nav.new-version")} ${upgrade.version} ${i18n.t("admin.nav.update-available")}`;
    return (
      <Button
        variant="secondary"
        block
        title={label}
        onClick={() =>
          window.open(upgrade.url, "_blank", "noopener,noreferrer")
        }
      >
        {label}
      </Button>
    );
  }

  return (
    <SidebarVersionRow
      label={i18n.t("admin.system.overview.server-version")}
      value={server?.version ? `v${server.version}` : "v-"}
      title={server?.version ?? ""}
    />
  );
}
