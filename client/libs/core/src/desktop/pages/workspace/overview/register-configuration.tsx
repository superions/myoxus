// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState } from "react";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useServices } from "@myoxus/infra";
import { TagService } from "@myoxus/core/modules/tag";
import { DocumentMetadataCacheService } from "@myoxus/core/modules/document-metadata/services/document-metadata-cache";
import { DisplayProperties } from "@myoxus/core/components/explorer/display-menu/properties";
import {
  OrderByList,
  OrderByName,
} from "@myoxus/core/components/explorer/display-menu/order";
import {
  Button,
  FormFieldset,
  FormSelect,
  Group,
  LocalizedDateTimeInput,
  Menu,
  MenuPanel,
  MenuItem,
  MultiSelect,
  MyoxusText,
  Stack,
  Switch,
} from "@myoxus/ui-facade";
import {
  overviewRegisterProperties,
  type OverviewRegisterPresentation,
} from "./presentation";

/** One editor for routed and embedded registers. The consumer owns save/cancel. */
export function OverviewRegisterConfiguration({
  value,
  onChange,
  disabled = false,
}: {
  value: OverviewRegisterPresentation;
  onChange: (value: OverviewRegisterPresentation) => void;
  disabled?: boolean;
}) {
  const t = useI18n();
  const { tagService, documentMetadataCacheService } = useServices({
    TagService,
    DocumentMetadataCacheService,
  });
  const catalog = useLiveData(tagService.tagList.catalogState$);
  const lookups = useLiveData(documentMetadataCacheService.watchIndexLookups());
  const [lookupError, setLookupError] = useState(false);
  useEffect(() => {
    let active = true;
    void documentMetadataCacheService.hydrateIndexLookups().catch(() => {
      if (active) setLookupError(true);
    });
    return () => {
      active = false;
    };
  }, [documentMetadataCacheService]);
  const selection = value.selection;
  const update = (patch: Partial<OverviewRegisterPresentation["selection"]>) =>
    onChange({ ...value, selection: { ...selection, ...patch } });
  const filterKeys = ["documentType", "status", "reviewDueAt", "validUntil"];
  const filterLabels = [
    t["com.myoxus.document-metadata.field.document-type"](),
    t["com.myoxus.document-metadata.field.status"](),
    t["com.myoxus.document-metadata.field.review-due-at"](),
    t["com.myoxus.document-metadata.field.valid-until"](),
  ];
  const methods = [
    "is",
    "is-not",
    "is-empty",
    "is-not-empty",
    "before",
    "after",
  ] as const;
  return (
    <Stack>
      <Group>
        <Menu
          items={
            <MenuPanel panelWidth="display">
              <DisplayProperties
                displayPreference={value}
                systemPropertyKeys={overviewRegisterProperties}
                requiredSystemProperties={["title"]}
                onDisplayPreferenceChange={(next) =>
                  onChange({
                    ...value,
                    displayProperties:
                      next.displayProperties ?? value.displayProperties,
                  })
                }
              />
            </MenuPanel>
          }
        >
          <Button variant="secondary" disabled={disabled}>
            {t["com.myoxus.all-docs.display.properties"]()}
          </Button>
        </Menu>
        <Menu
          title={t["com.myoxus.explorer.display-menu.ordering"]()}
          items={
            <MenuPanel panelWidth="display">
              <MenuItem
                selected={value.orderBy.key === "organizer"}
                onClick={() =>
                  onChange({
                    ...value,
                    orderBy: { type: "system", key: "organizer", desc: false },
                  })
                }
              >
                {t["com.myoxus.wiki.directory.organizer"]()}
              </MenuItem>
              <OrderByList
                orderBy={
                  value.orderBy.key === "organizer" ? undefined : value.orderBy
                }
                systemPropertyKeys={overviewRegisterProperties}
                onChange={(next) =>
                  onChange({
                    ...value,
                    orderBy: {
                      type: next.type,
                      key: next.key,
                      desc: next.desc ?? false,
                    },
                  })
                }
              />
            </MenuPanel>
          }
        >
          <Button variant="secondary" disabled={disabled}>
            {t["com.myoxus.explorer.display-menu.ordering"]()}
            {" · "}
            {value.orderBy.key === "organizer" ? (
              t["com.myoxus.wiki.directory.organizer"]()
            ) : (
              <OrderByName orderBy={value.orderBy} />
            )}
          </Button>
        </Menu>
      </Group>
      <FormFieldset disabled={disabled} variant="unstyled">
        <Stack>
          <Switch
            checked={selection.subtree}
            onChange={(subtree) => update({ subtree })}
          >
            {t["com.myoxus.wiki.directory.subtree"]()}
          </Switch>
          <MultiSelect
            label={t["com.myoxus.wiki.directory.labels"]()}
            data={catalog.tags
              .filter((tag) => !tag.archived)
              .map((tag) => ({ value: tag.id, label: tag.value }))}
            value={selection.tagIds}
            onChange={(tagIds) => update({ tagIds })}
          />
          <Switch
            checked={selection.matchAllTags}
            onChange={(matchAllTags) => update({ matchAllTags })}
          >
            {t["com.myoxus.wiki.directory.all-labels"]()}
          </Switch>
          <MyoxusText>{t["com.myoxus.wiki.directory.filter"]()}</MyoxusText>
          {selection.filters.map((filter, index) => (
            <Stack key={index}>
              <Group>
                <FormSelect
                  aria-label={t["com.myoxus.wiki.directory.filter"]()}
                  data={filterKeys.map((value, i) => ({
                    value,
                    label: filterLabels[i],
                  }))}
                  value={filter.key}
                  onChange={(key) =>
                    update({
                      filters: selection.filters.map((f, i) =>
                        i === index
                          ? { key: key!, method: "is-empty", value: null }
                          : f,
                      ),
                    })
                  }
                />
                <FormSelect
                  aria-label={t["com.myoxus.wiki.directory.filter"]()}
                  data={methods
                    .filter((method) =>
                      /At$|Until$/.test(filter.key)
                        ? [
                            "before",
                            "after",
                            "is-empty",
                            "is-not-empty",
                          ].includes(method)
                        : !["before", "after"].includes(method),
                    )
                    .map((value) => ({
                      value,
                      label: t[`com.myoxus.wiki.directory.${value}`](),
                    }))}
                  value={filter.method}
                  onChange={(method) =>
                    update({
                      filters: selection.filters.map((f, i) =>
                        i === index
                          ? { ...f, method: method!, value: null }
                          : f,
                      ),
                    })
                  }
                />
                <Button
                  variant="plain"
                  onClick={() =>
                    update({
                      filters: selection.filters.filter((_, i) => i !== index),
                    })
                  }
                >
                  {t["com.myoxus.wiki.directory.remove-filter"]()}
                </Button>
              </Group>
              {!filter.method.includes("empty") &&
                (filter.key === "status" || filter.key === "documentType" ? (
                  <FormSelect
                    label={filterLabels[filterKeys.indexOf(filter.key)]}
                    value={filter.value ?? null}
                    data={Object.entries(
                      filter.key === "status"
                        ? (lookups?.statusLabels ?? {})
                        : (lookups?.documentTypeLabels ?? {}),
                    ).map(([value, label]) => ({ value, label }))}
                    onChange={(value) =>
                      update({
                        filters: selection.filters.map((f, i) =>
                          i === index ? { ...f, value } : f,
                        ),
                      })
                    }
                  />
                ) : (
                  <LocalizedDateTimeInput
                    locale={t.language}
                    label={filterLabels[filterKeys.indexOf(filter.key)]}
                    value={filter.value ? new Date(filter.value) : null}
                    onChange={(date) =>
                      update({
                        filters: selection.filters.map((f, i) =>
                          i === index
                            ? {
                                ...f,
                                value: date
                                  ? new Date(date).toISOString()
                                  : null,
                              }
                            : f,
                        ),
                      })
                    }
                  />
                ))}
            </Stack>
          ))}
          <Button
            variant="secondary"
            onClick={() =>
              update({
                filters: [
                  ...selection.filters,
                  { key: "status", method: "is-empty", value: null },
                ],
              })
            }
          >
            {t["com.myoxus.wiki.directory.add-filter"]()}
          </Button>
        </Stack>
      </FormFieldset>
      {lookupError && (
        <MyoxusText role="alert">
          {t["com.myoxus.wiki.directory.error"]()}
        </MyoxusText>
      )}
    </Stack>
  );
}
