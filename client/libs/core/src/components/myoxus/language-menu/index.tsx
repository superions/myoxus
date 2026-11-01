import { I18nService, type LanguageInfo } from "@myoxus/core/modules/i18n";
import { useUserPreferences } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Menu,
  MenuItem,
  MenuScrollableSection,
  MenuTrigger,
} from "@myoxus/ui-facade";
import { memo } from "react";

const LanguageMenuContent = memo(function LanguageMenuContent({
  current,
  onChange,
  languageList,
}: {
  languageList: LanguageInfo[];
  current: string;
  onChange: (value: string) => void;
}) {
  return (
    <MenuScrollableSection maxHeight="default">
      {languageList.map((lang) => {
        const selected = current === lang.key;
        return (
          <MenuItem
            key={lang.name}
            title={lang.name}
            lang={lang.key}
            onSelect={() => onChange(lang.key)}
            suffix={lang.completeness + "%"}
            selected={selected}
          >
            {lang.originalName}
          </MenuItem>
        );
      })}
    </MenuScrollableSection>
  );
});

export const LanguageMenu = () => {
  const i18n = useService(I18nService).i18n;
  const currentLanguage = useLiveData(i18n.currentLanguage$);
  const languageList = useLiveData(i18n.languageList$);
  const { updatePreferences } = useUserPreferences();

  return (
    <Menu
      items={
        <LanguageMenuContent
          current={currentLanguage.key}
          onChange={(language) => {
            i18n.changeLanguage(language);
            void updatePreferences({ locale: language });
          }}
          languageList={languageList}
        />
      }
      contentOptions={{
        align: "end",
        panelWidth: "comfortable",
      }}
    >
      <MenuTrigger data-testid="language-menu-button" block={true}>
        {currentLanguage.originalName}
      </MenuTrigger>
    </Menu>
  );
};
