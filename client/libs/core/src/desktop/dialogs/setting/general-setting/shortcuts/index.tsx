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

const ShortcutsPanel = ({
  shortcutsInfo,
}: {
  shortcutsInfo: ShortcutsInfo;
}) => {
  return (
    <SettingWrapper title={shortcutsInfo.title}>
      <SurfaceList
        label={shortcutsInfo.title}
        data-testid="keyboard-shortcut-list"
      >
        {Object.entries(shortcutsInfo.shortcuts).map(([title, shortcuts]) => {
          return (
            <SurfaceListItem
              key={title}
              component="li"
              alignItems="center"
              appearance="row"
              density="compact"
              justifyContent="space-between"
              layout="row"
            >
              <SurfaceListItemMain grow compact>
                <SettingsListItemTitle>{title}</SettingsListItemTitle>
              </SurfaceListItemMain>
              <BadgeList>
                {shortcuts.map((key) => {
                  return (
                    <BadgeListItem key={key}>
                      <Badge>{key}</Badge>
                    </BadgeListItem>
                  );
                })}
              </BadgeList>
            </SurfaceListItem>
          );
        })}
      </SurfaceList>
    </SettingWrapper>
  );
};

export const Shortcuts = () => {
  const t = useI18n();

  const markdownShortcutsInfo = useMarkdownShortcuts();
  const pageShortcutsInfo = usePageShortcuts();
  const edgelessShortcutsInfo = useEdgelessShortcuts();
  const generalShortcutsInfo = useGeneralShortcuts();

  return (
    <>
      <SettingHeader
        title={t["com.myoxus.keyboardShortcuts.title"]()}
        subtitle={t["com.myoxus.keyboardShortcuts.subtitle"]()}
        data-testid="keyboard-shortcuts-title"
      />
      <ShortcutsPanel shortcutsInfo={generalShortcutsInfo} />
      <ShortcutsPanel shortcutsInfo={pageShortcutsInfo} />
      <ShortcutsPanel shortcutsInfo={edgelessShortcutsInfo} />
      <ShortcutsPanel shortcutsInfo={markdownShortcutsInfo} />
    </>
  );
};
