import {
  createDocExplorerContext,
  DocExplorerContext,
} from "@myoxus/core/components/explorer/context";
import { DocListItemComponent } from "@myoxus/core/components/explorer/docs-view/docs-list";
import { Filters } from "@myoxus/core/components/filter";
import type { CollectionInfo } from "@myoxus/core/modules/collection";
import { CollectionRulesService } from "@myoxus/core/modules/collection-rules";
import { DocsService } from "@myoxus/core/modules/doc";
import { DocDisplayMetaService } from "@myoxus/core/modules/doc-display-meta";
import { Trans, useI18n } from "@myoxus/i18n";
import { EdgelessIcon, PageIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Accordion,
  AccordionControl,
  AccordionItem,
  AccordionPanel,
  BadgeList,
  BadgeListItem,
  Button,
  DialogFooter,
  Divider,
  EmptyState,
  Flex,
  Group,
  MyoxusText,
  RemovableBadge,
  Scrollable,
  Stack,
  SurfaceListHeader,
  SurfaceListHeaderTitle,
  SurfaceListItemIcon,
  SurfaceListText,
} from "@myoxus/ui-facade";
import { memo, type ReactNode, useEffect, useMemo, useState } from "react";

export const RulesMode = ({
  collection,
  updateCollection,
  reset,
  buttons,
}: {
  collection: CollectionInfo;
  updateCollection: (collection: CollectionInfo) => void;
  reset: () => void;
  buttons: ReactNode;
}) => {
  const t = useI18n();
  const [showPreview, setShowPreview] = useState(false);
  const docsService = useService(DocsService);
  const collectionRulesService = useService(CollectionRulesService);
  const [rulesPageIds, setRulesPageIds] = useState<string[]>([]);
  const [docExplorerContextValue] = useState(() =>
    createDocExplorerContext({
      displayProperties: ["createdAt", "updatedAt", "tags"],
      showDragHandle: false,
      showMoreOperation: false,
      quickFavorite: true,
      groupBy: undefined,
      orderBy: undefined,
    }),
  );

  useEffect(() => {
    const subscription = collectionRulesService
      .watch({
        filters: collection.rules.filters,
        extraFilters: [
          {
            type: "system",
            key: "trash",
            method: "is",
            value: "false",
          },
          {
            type: "system",
            key: "empty-journal",
            method: "is",
            value: "false",
          },
        ],
        orderBy: {
          type: "system",
          key: "updatedAt",
          desc: true,
        },
      })
      .subscribe((rules) => {
        setRulesPageIds(rules.groups.flatMap((group) => group.items));
      });
    return () => {
      subscription.unsubscribe();
    };
  }, [collection, collectionRulesService]);

  const previewIsEmpty =
    rulesPageIds.length === 0 && collection.allowList.length === 0;
  const editorIsEmpty =
    collection.rules.filters.length === 0 && collection.allowList.length === 0;

  useEffect(() => {
    if (editorIsEmpty) {
      setShowPreview(false);
    }
  }, [editorIsEmpty]);

  const filters = (
    <Filters
      filters={collection.rules.filters}
      onChange={(filters) => {
        updateCollection({
          ...collection,
          rules: {
            ...collection.rules,
            filters,
          },
        });
      }}
    />
  );

  const tips = useMemo(
    () => (
      <Trans
        i18nKey="com.myoxus.editCollection.rules.tips"
        values={{
          highlight: t["com.myoxus.editCollection.rules.tips.highlight"](),
        }}
        components={{
          2: (
            <MyoxusText
              component="span"
              tone="accent"
              typographySlot="body-small"
            />
          ),
        }}
      />
    ),
    [t],
  );

  return (
    <Stack data-myoxus-ui-role="collection-rules-mode" h="100%" mih={0}>
      <Group
        align="flex-start"
        data-myoxus-ui-role="collection-rules-toolbar"
        justify="space-between"
      >
        <MyoxusText
          component="div"
          data-myoxus-ui-role="collection-rules-title-text"
          tone="secondary"
          typographySlot="body-small"
        >
          {tips}
        </MyoxusText>
        <Group data-myoxus-ui-role="collection-rules-secondary-actions">
          <Button
            aria-pressed={showPreview}
            disabled={editorIsEmpty}
            onClick={() => setShowPreview((current) => !current)}
            variant={showPreview ? "primary" : "secondary"}
          >
            {t["com.myoxus.editCollection.rules.preview"]()}
          </Button>
          <Button variant="plain" onClick={reset}>
            {t["com.myoxus.editCollection.rules.reset"]()}
          </Button>
        </Group>
      </Group>

      <Flex data-myoxus-ui-role="collection-rules-body" flex="1 1 0" mih={0}>
        <Flex
          data-myoxus-ui-role="collection-rules-editor-pane"
          direction="column"
          flex="1 1 auto"
          mih={0}
          miw={0}
        >
          <Flex
            data-myoxus-ui-role="collection-rules-editor-content"
            direction="column"
            flex="1 1 auto"
            mih={0}
          >
            <Scrollable.Viewport
              fill
              data-myoxus-ui-role="collection-rules-filter-stack"
            >
              {editorIsEmpty ? (
                <RulesEmpty action={filters} noRules />
              ) : (
                <Stack data-myoxus-ui-role="collection-rules-editor-stack">
                  {filters}
                  {collection.allowList.length > 0 ? (
                    <Accordion
                      defaultValue="include"
                      data-myoxus-ui-role="collection-rules-include-editor"
                    >
                      <AccordionItem value="include">
                        <AccordionControl>
                          <Group>
                            <MyoxusText
                              component="span"
                              tone="secondary"
                              typographySlot="body-small"
                            >
                              {t[
                                "com.myoxus.editCollection.rules.include.title"
                              ]()}
                            </MyoxusText>
                            <MyoxusText
                              component="span"
                              tone="tertiary"
                              typographySlot="body-small"
                            >
                              · {collection.allowList.length}
                            </MyoxusText>
                          </Group>
                        </AccordionControl>
                        <AccordionPanel flushHorizontal>
                          <BadgeList data-myoxus-ui-role="collection-rules-include-items">
                            {collection.allowList.map((id) => {
                              return (
                                <BadgeListItem
                                  data-myoxus-ui-role="collection-rules-include-item"
                                  key={id}
                                >
                                  <RemovableBadge
                                    prefix={
                                      <SurfaceListItemIcon size="sm">
                                        {docsService.list.getPrimaryMode(id) ===
                                        "edgeless" ? (
                                          <EdgelessIcon />
                                        ) : (
                                          <PageIcon />
                                        )}
                                      </SurfaceListItemIcon>
                                    }
                                    removeLabel={t["Remove"]()}
                                    onRemove={() => {
                                      updateCollection({
                                        ...collection,
                                        allowList: collection.allowList.filter(
                                          (value) => value !== id,
                                        ),
                                      });
                                    }}
                                  >
                                    <MyoxusText
                                      component="span"
                                      typographySlot="body-small"
                                    >
                                      {t[
                                        "com.myoxus.editCollection.rules.include.page"
                                      ]()}
                                    </MyoxusText>{" "}
                                    <MyoxusText
                                      component="span"
                                      data-myoxus-ui-role="collection-rules-include-operator"
                                      tone="secondary"
                                      typographySlot="body-small"
                                    >
                                      {t[
                                        "com.myoxus.editCollection.rules.include.is"
                                      ]()}
                                    </MyoxusText>{" "}
                                    <DocTitle component="span" id={id} />
                                  </RemovableBadge>
                                </BadgeListItem>
                              );
                            })}
                          </BadgeList>
                        </AccordionPanel>
                      </AccordionItem>
                    </Accordion>
                  ) : null}
                </Stack>
              )}
            </Scrollable.Viewport>
          </Flex>
        </Flex>
        {showPreview ? (
          <>
            <Divider orientation="vertical" space="none" />
            <Flex
              data-myoxus-ui-role="collection-rules-preview-pane"
              flex="2 1 auto"
              mih={0}
              miw={0}
            >
              {previewIsEmpty ? (
                <RulesEmpty noRules={collection.rules.filters.length === 0} />
              ) : (
                <Scrollable.Viewport fill>
                  <DocExplorerContext.Provider value={docExplorerContextValue}>
                    <Stack gap={0}>
                      {rulesPageIds.map((docId) => (
                        <DocListItemComponent
                          key={`rule:${docId}`}
                          itemId={docId}
                          groupId="rules"
                        />
                      ))}
                      {collection.allowList.length > 0 ? (
                        <SurfaceListHeader
                          density="section"
                          data-myoxus-ui-role="collection-rules-include-list-header"
                        >
                          <SurfaceListHeaderTitle>
                            {t[
                              "com.myoxus.editCollection.rules.include.title"
                            ]()}
                          </SurfaceListHeaderTitle>
                        </SurfaceListHeader>
                      ) : null}
                      {collection.allowList.map((docId) => (
                        <DocListItemComponent
                          key={`include:${docId}`}
                          itemId={docId}
                          groupId="include"
                        />
                      ))}
                    </Stack>
                  </DocExplorerContext.Provider>
                </Scrollable.Viewport>
              )}
            </Flex>
          </>
        ) : null}
      </Flex>
      <DialogFooter data-myoxus-ui-role="collection-rules-footer">
        <Group data-myoxus-ui-role="collection-rules-footer-summary">
          <MyoxusText
            component="div"
            data-myoxus-ui-role="collection-rules-count-summary"
            tone="secondary"
            typographySlot="body-small"
          >
            <Trans
              i18nKey="com.myoxus.editCollection.rules.countTips"
              values={{
                selectedCount: collection.allowList.length,
                filteredCount: rulesPageIds.length,
              }}
            >
              Selected
              <MyoxusText
                component="span"
                tone="accent"
                typographySlot="body-small"
              >
                count
              </MyoxusText>
              , filtered
              <MyoxusText
                component="span"
                tone="accent"
                typographySlot="body-small"
              >
                count
              </MyoxusText>
            </Trans>
          </MyoxusText>
        </Group>
        {buttons}
      </DialogFooter>
    </Stack>
  );
};
const RulesEmpty = ({
  action,
  noRules,
}: {
  action?: ReactNode;
  noRules: boolean;
}) => {
  const t = useI18n();
  return (
    <EmptyState
      cta={action}
      data-myoxus-ui-role="collection-rules-empty"
      description={
        noRules ? (
          <Trans i18nKey="com.myoxus.editCollection.rules.empty.noRules.tips">
            Please <strong>add rules</strong> to save this collection or switch
            to <strong>Pages</strong>, use manual selection mode
          </Trans>
        ) : (
          t["com.myoxus.editCollection.rules.empty.noResults.tips"]()
        )
      }
      title={
        noRules
          ? t["com.myoxus.editCollection.rules.empty.noRules"]()
          : t["com.myoxus.editCollection.rules.empty.noResults"]()
      }
    />
  );
};

const DocTitle = memo(function DocTitle({
  component,
  id,
}: {
  component?: "div" | "span";
  id: string;
}) {
  const docDisplayMetaService = useService(DocDisplayMetaService);
  const docsService = useService(DocsService);
  const doc = useLiveData(docsService.list.doc$(id));
  const trash = useLiveData(doc?.trash$);
  const title = useLiveData(docDisplayMetaService.title$(id));

  return (
    <SurfaceListText
      data-myoxus-ui-role="collection-rules-include-title"
      kind="title"
      component={component}
      strikethrough={Boolean(trash)}
    >
      {title}
    </SurfaceListText>
  );
});
