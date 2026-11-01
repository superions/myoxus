import { useAsyncCallback } from "@myoxus/core/components/hooks/myoxus-async-hooks";
import { useRegionalPreferences } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import {
  type TemplateCategoryFilter,
  TemplateDocService,
  TemplateApplicationService,
  TemplateSuggestionSurface,
} from "@myoxus/core/modules/template-doc";
import {
  TemplateListMenu,
  TemplateListMenuAdd,
} from "@myoxus/core/modules/template-doc/view/template-list-menu";
import { useTemplateApplicationAction } from "@myoxus/core/modules/template-doc/view/use-template-application";
import { useI18n } from "@myoxus/i18n";
import { TemplateColoredIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import track from "@myoxus/track";
import { Button, MenuSeparator, PageContentRail } from "@myoxus/ui-facade";
import type { Store } from "@virgultum/editor/store";
import { useCallback, useEffect, useMemo, useState } from "react";

const genericPickerFilter: TemplateCategoryFilter = { exclude: ["onboarding"] };

const EmptyDocumentTemplateButton = ({ doc }: { doc: Store }) => {
  const t = useI18n();

  const { apply, pending, triggerRef } = useTemplateApplicationAction(
    "sidebar",
    doc.id,
  );
  const regionalPreferences = useRegionalPreferences();

  const [templateMenuOpen, setTemplateMenuOpen] = useState(false);

  const handleSelectTemplate = useAsyncCallback(
    async (templateId: string) => {
      const result = await apply(templateId, {
        creationContext: {},
        date: new Date(),
        regionalPreferences,
        targetDocId: doc.id,
      });
      if (!result.ok) return;
      track.doc.editor.starterBar.quickStart({ with: "template" });
    },
    [doc.id, regionalPreferences, apply],
  );

  const onTemplateMenuOpenChange = useCallback((open: boolean) => {
    if (open) track.doc.editor.starterBar.openTemplateListMenu();
    setTemplateMenuOpen(open);
  }, []);

  return (
    <PageContentRail
      width="editor"
      data-myoxus-ui-role="editor-template-launcher"
    >
      <TemplateListMenu
        disabled={pending}
        onSelect={handleSelectTemplate}
        categoryFilter={genericPickerFilter}
        suggestionSurface={TemplateSuggestionSurface.StarterBar}
        rootOptions={{
          open: templateMenuOpen,
          onOpenChange: onTemplateMenuOpenChange,
        }}
        suffixItems={
          <>
            <MenuSeparator />
            <TemplateListMenuAdd />
          </>
        }
      >
        <Button
          ref={triggerRef as React.Ref<HTMLButtonElement>}
          loading={pending}
          aria-busy={pending}
          aria-label={pending ? t["Loading"]() : undefined}
          data-testid="template-docs-button"
          data-myoxus-ui-role="button:editor-template-launcher"
          prefix={<TemplateColoredIcon />}
          variant={templateMenuOpen ? "primary" : "secondary"}
        >
          {t["com.myoxus.page-starter-bar.template"]()}
        </Button>
      </TemplateListMenu>
    </PageContentRail>
  );
};

export const StarterBar = ({ doc }: { doc: Store }) => {
  const [isEmpty, setIsEmpty] = useState(doc.isEmpty);
  const templateDocService = useService(TemplateDocService);
  const application = useService(TemplateApplicationService);
  const pending = useLiveData(
    useMemo(
      () =>
        application.pending$.selector((keys) =>
          keys.has(TemplateApplicationService.targetKey(doc.id)),
        ),
      [application, doc.id],
    ),
  );

  const isTemplate = useLiveData(
    useMemo(
      () => templateDocService.list.isTemplate$(doc.id),
      [doc.id, templateDocService.list],
    ),
  );

  useEffect(() => {
    return doc.isEmpty$.subscribe((value) => {
      setIsEmpty(value);
    });
  }, [doc]);

  // Keep the initiating control mounted through copy/compensation so failure
  // can restore focus after the native empty state is restored.
  if ((!isEmpty && !pending) || isTemplate) return null;

  return <EmptyDocumentTemplateButton doc={doc} />;
};
