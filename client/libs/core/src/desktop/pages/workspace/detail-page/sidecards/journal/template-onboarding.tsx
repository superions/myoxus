/** Journal template onboarding content. */
import { GlobalStateService } from "@myoxus/core/modules/storage";
import {
  type TemplateCategoryFilter,
  TemplateApplicationService,
  TemplateSuggestionSurface,
} from "@myoxus/core/modules/template-doc";
import { TemplateListMenuContentScrollable } from "@myoxus/core/modules/template-doc/view/template-list-menu";
import { useI18n } from "@myoxus/i18n";
import { TemplateIcon } from "@myoxus/icons/react";
import { LiveData, useLiveData, useService } from "@myoxus/infra";
import {
  Alert,
  Button,
  Group,
  Menu,
  MyoxusText,
  Stack,
} from "@myoxus/ui-facade";
import { useCallback, useMemo } from "react";

const journalPickerFilter: TemplateCategoryFilter = {
  include: ["journal-daily"],
};

const dismissedKey = "journal-template-onboarding-dismissed";

export const JournalTemplateOnboarding = () => {
  const globalState = useService(GlobalStateService).globalState;
  const application = useService(TemplateApplicationService);
  const t = useI18n();

  const dismissed = useLiveData(
    useMemo(
      () => LiveData.from(globalState.watch(dismissedKey), false),
      [globalState],
    ),
  );

  const onDismiss = useCallback(() => {
    globalState.set(dismissedKey, true);
  }, [globalState]);

  const updateJournalTemplate = useCallback(
    (templateId: string) => {
      void application.updateJournalDefault(templateId);
    },
    [application],
  );

  if (dismissed) return null;

  return (
    <Alert
      icon={<TemplateIcon />}
      withCloseButton
      closeButtonLabel={t["com.myoxus.peek-view-controls.close"]()}
      onClose={onDismiss}
      data-testid="journal-template-onboarding"
      data-myoxus-ui-role="journal-template-onboarding"
    >
      <Stack>
        <MyoxusText
          typographySlot="nav"
          data-myoxus-ui-role="journal-template-onboarding-title"
        >
          {t["com.myoxus.template-journal-onboarding.title"]()}
        </MyoxusText>
        <MyoxusText>
          {t["com.myoxus.template-input.journal-restriction"]()}
        </MyoxusText>
        <Group>
          <Menu
            contentOptions={{ panelWidth: "wide", align: "end" }}
            items={
              <TemplateListMenuContentScrollable
                onSelect={updateJournalTemplate}
                categoryFilter={journalPickerFilter}
                suggestionSurface={TemplateSuggestionSurface.JournalOnboarding}
              />
            }
          >
            <Button variant="primary" prefix={<TemplateIcon />}>
              {t["com.myoxus.template-journal-onboarding.select"]()}
            </Button>
          </Menu>
        </Group>
      </Stack>
    </Alert>
  );
};
