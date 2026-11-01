import { DocsService } from "@myoxus/core/modules/doc";
import { DocDisplayMetaService } from "@myoxus/core/modules/doc-display-meta";
import {
  type TemplateCategoryFilter,
  TemplateDocService,
  TemplateApplicationService,
} from "@myoxus/core/modules/template-doc";
import { TemplateListMenu } from "@myoxus/core/modules/template-doc/view/template-list-menu";
import { useI18n } from "@myoxus/i18n";
import { DeleteIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import { useCallback } from "react";

import {
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  SettingRow,
  SettingWrapper,
  Switch,
} from "../../primitives";

const genericPickerFilter: TemplateCategoryFilter = { exclude: ["onboarding"] };

export const TemplateDocSetting = () => {
  const t = useI18n();
  const templateDocService = useService(TemplateDocService);
  const application = useService(TemplateApplicationService);
  const setting = templateDocService.setting;

  const enablePageTemplate = useLiveData(setting.enablePageTemplate$);
  const pageTemplateDocId = useLiveData(setting.pageTemplateDocId$);
  const journalTemplateDocId = useLiveData(setting.journalTemplateDocId$);

  const togglePageTemplate = useCallback(
    (enable: boolean) => {
      setting.togglePageTemplate(enable);
    },
    [setting],
  );

  const updatePageTemplate = useCallback(
    (id?: string) => {
      void application.updatePageDefault(id);
    },
    [application],
  );

  const updateJournalTemplate = useCallback(
    (id?: string) => {
      void application.updateJournalDefault(id);
    },
    [application],
  );

  return (
    <SettingWrapper title={t["com.myoxus.settings.workspace.template.title"]()}>
      <SettingRow
        name={t["com.myoxus.settings.workspace.template.journal"]()}
        desc={t["com.myoxus.template-input.journal-restriction"]()}
      >
        <TemplateSelector
          testId="journal-template-selector"
          current={journalTemplateDocId}
          onChange={updateJournalTemplate}
        />
      </SettingRow>
      <SettingRow
        name={t["com.myoxus.settings.workspace.template.page"]()}
        desc={t["com.myoxus.settings.workspace.template.page-desc"]()}
      >
        <Switch
          data-testid="page-template-switch"
          checked={enablePageTemplate}
          onChange={togglePageTemplate}
        />
      </SettingRow>
      {enablePageTemplate ? (
        <SettingRow
          name={t["com.myoxus.settings.workspace.template.page-select"]()}
          desc={null}
        >
          <TemplateSelector
            testId="page-template-selector"
            current={pageTemplateDocId}
            onChange={updatePageTemplate}
          />
        </SettingRow>
      ) : null}
    </SettingWrapper>
  );
};

interface TemplateSelectorProps {
  current?: string;
  testId?: string;
  onChange?: (id?: string) => void;
}
const TemplateSelector = ({
  current,
  testId,
  onChange,
}: TemplateSelectorProps) => {
  const t = useI18n();
  const docsService = useService(DocsService);
  const docDisplayService = useService(DocDisplayMetaService);
  const doc = useLiveData(current ? docsService.list.doc$(current) : null);
  const title = useLiveData(doc ? docDisplayService.title$(doc.id) : null);
  // const isInTrash = useLiveData(doc?.trash$);

  return (
    <TemplateListMenu
      onSelect={onChange}
      categoryFilter={genericPickerFilter}
      contentOptions={{ align: "end" }}
      suffixItems={
        <>
          <MenuSeparator />
          <MenuItem
            prefixIcon={<DeleteIcon />}
            onClick={() => onChange?.()}
            type="danger"
            data-testid="template-doc-item-remove"
          >
            {t["com.myoxus.settings.workspace.template.remove"]()}
          </MenuItem>
        </>
      }
    >
      <MenuTrigger data-testid={testId}>
        {/* TODO: in trash design */}
        {title ?? t["com.myoxus.settings.workspace.template.keep-empty"]()}
      </MenuTrigger>
    </TemplateListMenu>
  );
};
