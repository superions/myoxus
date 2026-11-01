import { useAsyncCallback } from "@myoxus/core/components/hooks/myoxus-async-hooks";
import { inferOpenMode } from "@myoxus/core/utils";
import { useI18n } from "@myoxus/i18n";
import {
  DualLinkIcon,
  InformationIcon,
  TemplateIcon,
} from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  InlineLink,
  Menu,
  MenuDetailRow,
  MenuInlineText,
  MenuItem,
  type MenuProps,
  MenuScrollableSection,
  MenuSection,
} from "@myoxus/ui-facade";
import { type MouseEvent, useEffect, useMemo } from "react";

import { type DocRecord, DocsService } from "../../doc";
import { DocDisplayMetaService } from "../../doc-display-meta";
import { WorkbenchService } from "../../workbench/services/workbench";
import { BuiltinTemplateReconcilerService } from "../services/builtin-reconciler";
import {
  type LoadTemplateSuggestionsOptions,
  type TemplateCategoryFilter,
  TemplateDocService,
  type TemplateSuggestionMenuItem,
  TemplateSuggestionSurface,
} from "../services/template-doc";
interface CommonProps {
  disabled?: boolean;
  onSelect?: (docId: string) => void;
  onSelectTemplate?: (item: TemplateSuggestionMenuItem) => void;
  asLink?: boolean;
  suggestionSurface?: TemplateSuggestionSurface;
  suggestionRequest?: LoadTemplateSuggestionsOptions;
}

interface DocItemProps extends CommonProps {
  doc: DocRecord;
}

const DocItem = ({
  doc,
  onSelect,
  onSelectTemplate,
  asLink,
  disabled,
}: DocItemProps) => {
  const docDisplayService = useService(DocDisplayMetaService);
  const workbench = useService(WorkbenchService).workbench;
  const Icon = useLiveData(docDisplayService.icon$(doc.id));
  const title = useLiveData(docDisplayService.title$(doc.id));

  const onClick = useAsyncCallback(
    async (e: MouseEvent<HTMLElement>) => {
      if (disabled) return;
      onSelect?.(doc.id);
      onSelectTemplate?.({
        templateId: doc.id,
        templateDocId: doc.id,
        title: title || doc.id,
        description: null,
        origin: "unknown",
        updatedAt: doc.updatedAt$.value ?? null,
        category: null,
        tags: [],
        score: 0,
        reasons: [],
        instanceState: "local",
        available: true,
        protectedSource: false,
      });
      if (asLink) {
        workbench.openDoc(doc.id, { at: inferOpenMode(e) });
      }
    },
    [asLink, disabled, doc.id, onSelect, onSelectTemplate, title, workbench],
  );

  return (
    <MenuItem
      disabled={disabled}
      prefixIcon={<Icon />}
      onClick={onClick}
      onAuxClick={onClick}
      data-testid={`template-doc-item-${doc.id}`}
    >
      {title}
    </MenuItem>
  );
};

interface SuggestionItemProps extends CommonProps {
  item: TemplateSuggestionMenuItem;
}

const SuggestionItem = ({
  item,
  onSelect,
  onSelectTemplate,
  asLink,
  disabled,
  suggestionRequest,
}: SuggestionItemProps) => {
  const t = useI18n();
  const templateDocService = useService(TemplateDocService);
  const workbench = useService(WorkbenchService).workbench;
  const docId = item.templateDocId;
  const accessDenied = item.reasons.includes("AccessDenied");
  const title = accessDenied
    ? t["com.myoxus.templates.library.source.restricted"]()
    : item.title;
  const stateLabel = item.reasons.includes("IncompatibleClient")
    ? t["com.myoxus.templates.library.readiness.client-incompatible"]()
    : accessDenied
      ? t["com.myoxus.templates.library.readiness.access-denied"]()
      : item.reasons.includes("RetryableFailure")
        ? t["com.myoxus.templates.library.readiness.retryable-failure"]()
        : item.reasons.includes("SourceMissing")
          ? t["com.myoxus.templates.library.readiness.source-missing"]()
          : item.reasons.includes("Preparing")
            ? t["com.myoxus.templates.library.readiness.preparing"]()
            : item.reasons.includes("ReconcileRequired")
              ? t["com.myoxus.template-list.reconcile-required"]()
              : item.reasons.includes("Detached")
                ? t["com.myoxus.template-list.detached"]()
                : !item.available
                  ? t["com.myoxus.template-list.unavailable"]()
                  : null;
  const onClick = useAsyncCallback(
    async (e: MouseEvent<HTMLElement>) => {
      if (disabled || !docId || !item.available) return;
      if (
        !suggestionRequest ||
        !(await templateDocService.revalidateTemplateSuggestion(
          item.templateId,
          docId,
          suggestionRequest,
          item.sourceRevisionId,
        ))
      ) {
        return;
      }
      onSelect?.(docId);
      onSelectTemplate?.(item);
      if (asLink) {
        workbench.openDoc(docId, { at: inferOpenMode(e) });
      }
    },
    [
      asLink,
      disabled,
      docId,
      item,
      item.available,
      onSelect,
      onSelectTemplate,
      templateDocService,
      suggestionRequest,
      workbench,
    ],
  );

  return (
    <MenuItem
      prefixIcon={<TemplateIcon />}
      onClick={onClick}
      onAuxClick={onClick}
      disabled={disabled || !docId || !item.available}
      suffix={
        stateLabel ? (
          <MenuInlineText tone="secondary">{stateLabel}</MenuInlineText>
        ) : null
      }
      data-testid={`template-suggestion-item-${item.templateId}`}
    >
      {title}
    </MenuItem>
  );
};

const TemplateMenuStatus = ({ children }: { children: React.ReactNode }) => (
  <MenuDetailRow data-myoxus-ui-role="template-menu-status-row">
    <MenuInlineText prefixIcon={<InformationIcon />} tone="secondary">
      {children}
    </MenuInlineText>
  </MenuDetailRow>
);

const Empty = () => {
  const t = useI18n();
  return (
    <MenuDetailRow
      data-myoxus-ui-role="template-menu-empty-row"
      right={
        <InlineLink
          href={BUILD_CONFIG.docsUrl}
          target="_blank"
          rel="noopener noreferrer"
          prefix={<DualLinkIcon aria-hidden />}
        >
          {t["com.myoxus.docs.header"]()}
        </InlineLink>
      }
    >
      <MenuInlineText prefixIcon={<InformationIcon />} tone="secondary">
        {t["com.myoxus.template-list.empty"]()}
      </MenuInlineText>
    </MenuDetailRow>
  );
};

interface TemplateListMenuContentProps extends CommonProps {
  prefixItems?: React.ReactNode;
  suffixItems?: React.ReactNode;
  /**
   * Optional category narrowing within the selected suggestion surface.
   * Menus without an explicit surface use ordinary document eligibility.
   */
  categoryFilter?: TemplateCategoryFilter;
  suggestionInput?: Omit<
    LoadTemplateSuggestionsOptions,
    "surface" | "locale" | "categoryFilter"
  >;
  loadSuggestionsOnMount?: boolean;
}
export const TemplateListMenuContent = ({
  prefixItems,
  suffixItems,
  categoryFilter,
  suggestionInput,
  suggestionSurface,
  loadSuggestionsOnMount = true,
  ...props
}: TemplateListMenuContentProps) => {
  const templateDocService = useService(TemplateDocService);
  const reconciler = useService(BuiltinTemplateReconcilerService);
  const t = useI18n();
  const suggestionRequest = useMemo(
    () =>
      suggestionSurface
        ? {
            ...suggestionInput,
            surface: suggestionSurface,
            categoryFilter,
            locale: t.language,
          }
        : undefined,
    [categoryFilter, suggestionInput, suggestionSurface, t.language],
  );
  const suggestions = useLiveData(templateDocService.templateSuggestions$);
  const settingsLoading = useLiveData(templateDocService.setting.loading$);
  const templateDocs = useLiveData(
    useMemo(
      () =>
        templateDocService.templateDocs$(
          categoryFilter,
          suggestionSurface ?? TemplateSuggestionSurface.AllPagesNewPage,
        ),
      [categoryFilter, suggestionSurface, templateDocService],
    ),
  );
  const shouldUseSuggestions =
    suggestionSurface &&
    suggestions.surface === suggestionSurface &&
    suggestions.status === "ready";
  const isLoading =
    settingsLoading ||
    (suggestionSurface &&
      suggestions.surface === suggestionSurface &&
      suggestions.status === "loading");
  const isError =
    suggestionSurface &&
    suggestions.surface === suggestionSurface &&
    suggestions.status === "error";
  const suggestionItems = useMemo(
    () => (shouldUseSuggestions ? suggestions.items : []),
    [shouldUseSuggestions, suggestions.items],
  );
  const remainingTemplateDocs = useMemo(() => {
    // Row bindings require Registry identities/publication guards. Local document
    // IDs remain valid in ordinary document pickers, never as catalog IDs.
    if (suggestionSurface === TemplateSuggestionSurface.DatabaseRowTemplate)
      return [];
    if (!suggestionItems.length) return templateDocs;

    // Ranked suggestions are an ordering aid, not a replacement catalog.
    // Keep workspace-authored templates reachable through the normal picker
    // while avoiding a second entry for a suggested local template document.
    const suggestedDocIds = new Set(
      suggestionItems.flatMap((item) =>
        item.templateDocId ? [item.templateDocId] : [],
      ),
    );
    return templateDocs.filter((doc) => !suggestedDocIds.has(doc.id));
  }, [suggestionItems, templateDocs, suggestionSurface]);
  useEffect(() => {
    if (!suggestionSurface || !loadSuggestionsOnMount) return;
    let mounted = true;
    templateDocService.invalidateTemplateSuggestions();
    void (async () => {
      await reconciler.reconcile();
      if (!mounted) return;
      await templateDocService.loadTemplateSuggestions(suggestionRequest!);
    })();
    return () => {
      mounted = false;
    };
  }, [
    categoryFilter,
    loadSuggestionsOnMount,
    reconciler,
    suggestionSurface,
    suggestionInput,
    suggestionRequest,
    t.language,
    templateDocService,
  ]);

  return (
    <MenuSection>
      {prefixItems}
      {isLoading ? (
        <TemplateMenuStatus>
          {t["com.myoxus.template-list.loading"]()}
        </TemplateMenuStatus>
      ) : null}
      {isError ? (
        <>
          <TemplateMenuStatus>
            {t["com.myoxus.template-list.load-error"]()}
          </TemplateMenuStatus>
          <MenuItem
            onClick={() => {
              if (!suggestionSurface) return;
              void templateDocService.loadTemplateSuggestions(
                suggestionRequest!,
              );
            }}
          >
            {t["Retry"]()}
          </MenuItem>
        </>
      ) : null}
      {suggestionItems.length || remainingTemplateDocs.length ? (
        <>
          {suggestionItems.map((item) => (
            <SuggestionItem
              key={item.templateId}
              item={item}
              suggestionRequest={suggestionRequest}
              {...props}
            />
          ))}
          {remainingTemplateDocs.map((doc) => (
            <DocItem key={doc.id} doc={doc} {...props} />
          ))}
        </>
      ) : !isLoading ? (
        <Empty />
      ) : null}
      {suffixItems}
    </MenuSection>
  );
};

export const TemplateListMenuContentScrollable = (
  props: TemplateListMenuContentProps,
) => {
  return (
    <MenuScrollableSection maxHeight="default">
      <TemplateListMenuContent {...props} />
    </MenuScrollableSection>
  );
};

interface TemplateListMenuProps
  extends TemplateListMenuContentProps, Omit<MenuProps, "items"> {}
export const TemplateListMenu = ({
  children,
  onSelect,
  onSelectTemplate,
  disabled,
  asLink,
  prefixItems,
  suffixItems,
  categoryFilter,
  suggestionSurface,
  suggestionInput,
  contentOptions,
  rootOptions,
  ...otherProps
}: TemplateListMenuProps) => {
  const reconciler = useService(BuiltinTemplateReconcilerService);
  const templateDocService = useService(TemplateDocService);
  const t = useI18n();
  return (
    <Menu
      items={
        <TemplateListMenuContentScrollable
          disabled={disabled}
          onSelect={onSelect}
          onSelectTemplate={onSelectTemplate}
          asLink={asLink}
          prefixItems={prefixItems}
          suffixItems={suffixItems}
          categoryFilter={categoryFilter}
          suggestionSurface={suggestionSurface}
          suggestionInput={suggestionInput}
          loadSuggestionsOnMount={false}
        />
      }
      contentOptions={{
        panelWidth: "display",
        ...contentOptions,
      }}
      rootOptions={{
        ...rootOptions,
        onOpen: () => {
          rootOptions?.onOpen?.();
          templateDocService.invalidateTemplateSuggestions();
          void (async () => {
            await reconciler.reconcile();
            if (suggestionSurface) {
              await templateDocService.loadTemplateSuggestions({
                ...suggestionInput,
                surface: suggestionSurface,
                categoryFilter,
                locale: t.language,
              });
            }
          })();
        },
      }}
      {...otherProps}
    >
      {children}
    </Menu>
  );
};

export const TemplateListMenuAdd = () => {
  const t = useI18n();
  const docsService = useService(DocsService);
  const workbench = useService(WorkbenchService).workbench;

  const createNewTemplate = useAsyncCallback(
    async (e: React.MouseEvent<HTMLElement>) => {
      const openMode = inferOpenMode(e);
      const record = await docsService.createTemplateDoc({}, "custom");
      workbench.openDoc(record.id, { at: openMode });
    },
    [docsService, workbench],
  );

  return (
    <MenuItem
      data-testid="template-doc-item-create"
      prefixIcon={<TemplateIcon />}
      onClick={createNewTemplate}
      onAuxClick={createNewTemplate}
    >
      {t["com.myoxus.template-list.create-new"]()}
    </MenuItem>
  );
};
