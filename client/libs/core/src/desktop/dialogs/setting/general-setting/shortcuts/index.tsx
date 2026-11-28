// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useI18n } from "@myoxus/i18n";

import {
  type ShortcutsInfo,
  useEdgelessShortcuts,
  useGeneralShortcuts,
  useMarkdownShortcuts,
  usePageShortcuts,
} from "../../../../../components/hooks/myoxus/use-shortcuts";
import {
  Badge,
  BadgeList,
  BadgeListItem,
  SettingHeader,
  SettingsListItemTitle,
  SettingWrapper,
  SurfaceList,
  SurfaceListItem,
  SurfaceListItemMain,
} from "../../primitives";

const ShortcutGroupSection = ({ group }: { group: ShortcutsInfo }) => (
  <SettingWrapper title={group.title}>
    <SurfaceList label={group.title} data-testid="keyboard-shortcut-list">
      {Object.entries(group.shortcuts).map(([actionLabel, keys]) => (
        <SurfaceListItem
          key={actionLabel}
          component="li"
          alignItems="center"
          appearance="row"
          density="compact"
          justifyContent="space-between"
          layout="row"
        >
          <SurfaceListItemMain grow compact>
            <SettingsListItemTitle>{actionLabel}</SettingsListItemTitle>
          </SurfaceListItemMain>
          <BadgeList>
            {keys.map((keyCombo) => (
              <BadgeListItem key={keyCombo}>
                <Badge>{keyCombo}</Badge>
              </BadgeListItem>
            ))}
          </BadgeList>
        </SurfaceListItem>
      ))}
    </SurfaceList>
  </SettingWrapper>
);

export const Shortcuts = () => {
  const t = useI18n();
  const general = useGeneralShortcuts();
  const page = usePageShortcuts();
  const edgeless = useEdgelessShortcuts();
  const markdown = useMarkdownShortcuts();

  return (
    <>
      <SettingHeader
        title={t["com.myoxus.keyboardShortcuts.title"]()}
        subtitle={t["com.myoxus.keyboardShortcuts.subtitle"]()}
        data-testid="keyboard-shortcuts-title"
      />
      <ShortcutGroupSection group={general} />
      <ShortcutGroupSection group={page} />
      <ShortcutGroupSection group={edgeless} />
      <ShortcutGroupSection group={markdown} />
    </>
  );
};
