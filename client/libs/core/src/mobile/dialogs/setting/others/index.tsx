import { useI18n } from "@myoxus/i18n";

import { SettingGroup } from "../group";
import { RowLayout } from "../row.layout";
import { DeleteAccount } from "./delete-account";

export const OthersGroup = () => {
  const t = useI18n();

  return (
    <SettingGroup title={t["com.myoxus.mobile.setting.others.title"]()}>
      <RowLayout
        label={t["com.myoxus.mobile.setting.others.website"]()}
        href={BUILD_CONFIG.githubUrl}
      />

      <RowLayout
        label={t["com.myoxus.auth.public-links.security"]()}
        href={BUILD_CONFIG.securityUrl}
      />

      <RowLayout
        label={t["com.myoxus.auth.public-links.license"]()}
        href={BUILD_CONFIG.licenseUrl}
      />
      <DeleteAccount />
    </SettingGroup>
  );
};
