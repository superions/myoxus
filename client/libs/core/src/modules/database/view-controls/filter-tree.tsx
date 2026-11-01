// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type DatabaseEffectiveViewStateQuery,
  DatabaseFilterConjunction,
  type DatabaseFilterGroupInput,
  DatabaseFilterOperator,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  ArrowDownSmallIcon,
  ArrowUpSmallIcon,
  PlusIcon,
  TrashIcon,
} from "@myoxus/icons/react";
import {
  Accordion,
  AccordionControl,
  AccordionItem,
  AccordionPanel,
  Button,
  Divider,
  Group,
  IconButton,
  MyoxusSegmentedControl,
  Select,
  Stack,
} from "@myoxus/ui-facade";

import { getFieldById, sortByPosition } from "../model";
import type { DatabaseRecord } from "../types";
import { DatabaseFilterValueControl } from "./filter-value-control";
import {
  createDatabaseFilterRule,
  databaseFieldSupportsSavedFilters,
  databaseFilterDefaultValue,
  databaseFilterOperators,
} from "./labels";

export type DatabaseViewControlSection =
  "filter" | "sort" | "group" | "fields" | "display" | "advanced";

export type DatabaseViewEditScope = "shared" | "personal";

export type DatabaseEffectiveViewState = NonNullable<
  NonNullable<
    DatabaseEffectiveViewStateQuery["workspace"]
  >["databaseEffectiveViewState"]
>;

export type DatabaseFilterRuleOutput = {
  fieldId: string;
  operator: DatabaseFilterOperator;
  value: { kind: string; value: unknown };
};

export type DatabaseFilterGroupOutput = {
  conjunction: DatabaseFilterConjunction;
  rules: DatabaseFilterRuleOutput[];
  groups?: DatabaseFilterGroupOutput[];
};

export function collectDatabaseFilterRules(
  group: DatabaseFilterGroupOutput | null,
  depth = 0,
  groupPath: number[] = [],
): Array<{
  conjunction: DatabaseFilterConjunction;
  depth: number;
  groupPath: number[];
  ruleIndex: number;
  rule: DatabaseFilterRuleOutput;
}> {
  if (!group) return [];
  return [
    ...group.rules.map((rule, ruleIndex) => ({
      conjunction: group.conjunction,
      depth,
      groupPath,
      ruleIndex,
      rule,
    })),
    ...(group.groups ?? []).flatMap((child, childIndex) =>
      collectDatabaseFilterRules(child, depth + 1, [...groupPath, childIndex]),
    ),
  ];
}

export function removeDatabaseFilterRule(
  group: DatabaseFilterGroupInput,
  groupPath: number[],
  ruleIndex: number,
): DatabaseFilterGroupInput {
  if (!groupPath.length) {
    return {
      ...group,
      rules: (group.rules ?? []).filter((_, index) => index !== ruleIndex),
    };
  }
  const [childIndex, ...remainingPath] = groupPath;
  const groups = (group.groups ?? [])
    .map((child, index) =>
      index === childIndex
        ? removeDatabaseFilterRule(child, remainingPath, ruleIndex)
        : child,
    )
    .filter(
      (child) =>
        (child.rules?.length ?? 0) > 0 || (child.groups?.length ?? 0) > 0,
    );
  return { ...group, groups };
}

export function createDatabaseFilterGroup(): DatabaseFilterGroupInput {
  return {
    conjunction: DatabaseFilterConjunction.And,
    groups: [],
    rules: [],
  };
}

export function moveDatabaseFilterItem<T>(
  items: T[],
  index: number,
  offset: -1 | 1,
) {
  const target = index + offset;
  if (target < 0 || target >= items.length) return items;
  const next = [...items];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function DatabaseFilterGroupEditor({
  depth = 0,
  group,
  onChange,
  record,
  tagOptions,
}: {
  depth?: number;
  group: DatabaseFilterGroupInput;
  onChange: (group: DatabaseFilterGroupInput) => void;
  record: DatabaseRecord;
  tagOptions: { label: string; value: string }[];
}) {
  const t = useI18n();
  const fields = sortByPosition(record.fields).filter(
    databaseFieldSupportsSavedFilters,
  );
  const fieldOptions = fields.map((field) => ({
    label: field.name,
    value: field.id,
  }));
  const rules = group.rules ?? [];
  const groups = group.groups ?? [];

  return (
    <Stack gap="sm" data-testid={`database-filter-group-${depth}`}>
      <Group justify="space-between" gap="xs" wrap="wrap">
        <MyoxusSegmentedControl
          aria-label={t["com.myoxus.database.filter.conjunction"]()}
          data={[
            {
              label: t["com.myoxus.database.filter.all"](),
              value: DatabaseFilterConjunction.And,
            },
            {
              label: t["com.myoxus.database.filter.any"](),
              value: DatabaseFilterConjunction.Or,
            },
          ]}
          value={group.conjunction ?? DatabaseFilterConjunction.And}
          onChange={(conjunction) =>
            onChange({
              ...group,
              conjunction: conjunction as DatabaseFilterConjunction,
            })
          }
        />
        <Group gap="xs" wrap="wrap">
          <Button
            size="xs"
            variant="secondary"
            prefix={<PlusIcon />}
            disabled={!fields.length}
            onClick={() => {
              const field = fields[0];
              if (field) {
                onChange({
                  ...group,
                  rules: [...rules, createDatabaseFilterRule(field)],
                });
              }
            }}
          >
            {t["com.myoxus.filter.add-filter"]()}
          </Button>
          {depth < 3 ? (
            <Button
              size="xs"
              variant="secondary"
              prefix={<PlusIcon />}
              onClick={() =>
                onChange({
                  ...group,
                  groups: [...groups, createDatabaseFilterGroup()],
                })
              }
            >
              {t["com.myoxus.database.filter.add-group"]()}
            </Button>
          ) : null}
        </Group>
      </Group>
      <Stack
        gap="sm"
        aria-label={t["com.myoxus.filter"]()}
        data-myoxus-ui-role="database-filter-rule-list"
      >
        {rules.map((rule, index) => {
          const field = getFieldById(record, rule.fieldId);
          if (!field) return null;
          return (
            <Stack
              key={`${rule.fieldId}:${index}`}
              gap="xs"
              data-myoxus-ui-role="database-filter-rule"
            >
              <Stack
                gap="xs"
                data-myoxus-ui-role="database-filter-rule-controls"
              >
                <Select
                  aria-label={t["com.myoxus.database.view.filter-field"]()}
                  data={fieldOptions}
                  value={rule.fieldId}
                  onChange={(fieldId) => {
                    const nextField = fieldId
                      ? getFieldById(record, fieldId)
                      : undefined;
                    if (!nextField) return;
                    onChange({
                      ...group,
                      rules: rules.map((candidate, candidateIndex) =>
                        candidateIndex === index
                          ? createDatabaseFilterRule(nextField)
                          : candidate,
                      ),
                    });
                  }}
                />
                <Select
                  aria-label={t["com.myoxus.database.view.filter-operator"]()}
                  data={databaseFilterOperators(t, field)}
                  value={rule.operator}
                  onChange={(operator) => {
                    if (!operator) return;
                    const typedOperator = operator as DatabaseFilterOperator;
                    onChange({
                      ...group,
                      rules: rules.map((candidate, candidateIndex) =>
                        candidateIndex === index
                          ? {
                              ...candidate,
                              operator: typedOperator,
                              value: databaseFilterDefaultValue(
                                field,
                                typedOperator,
                              ),
                            }
                          : candidate,
                      ),
                    });
                  }}
                />
                <DatabaseFilterValueControl
                  field={field}
                  rule={rule}
                  tagOptions={tagOptions}
                  onChange={(value) =>
                    onChange({
                      ...group,
                      rules: rules.map((candidate, candidateIndex) =>
                        candidateIndex === index
                          ? { ...candidate, value }
                          : candidate,
                      ),
                    })
                  }
                />
              </Stack>
              <Group justify="flex-end" gap="xs">
                <IconButton
                  aria-label={t["com.myoxus.database.filter.move-up"]()}
                  disabled={index === 0}
                  size="small"
                  variant="plain"
                  onClick={() =>
                    onChange({
                      ...group,
                      rules: moveDatabaseFilterItem(rules, index, -1),
                    })
                  }
                >
                  <ArrowUpSmallIcon />
                </IconButton>
                <IconButton
                  aria-label={t["com.myoxus.database.filter.move-down"]()}
                  disabled={index === rules.length - 1}
                  size="small"
                  variant="plain"
                  onClick={() =>
                    onChange({
                      ...group,
                      rules: moveDatabaseFilterItem(rules, index, 1),
                    })
                  }
                >
                  <ArrowDownSmallIcon />
                </IconButton>
                <IconButton
                  aria-label={`${t["Delete"]()}: ${field.name}`}
                  size="small"
                  variant="plain"
                  onClick={() =>
                    onChange({
                      ...group,
                      rules: rules.filter(
                        (_, candidateIndex) => candidateIndex !== index,
                      ),
                    })
                  }
                >
                  <TrashIcon />
                </IconButton>
              </Group>
              {index < rules.length - 1 ? <Divider /> : null}
            </Stack>
          );
        })}
      </Stack>
      {groups.length ? (
        <Accordion
          multiple
          defaultValue={groups.map((_, index) => String(index))}
        >
          {groups.map((child, index) => (
            <AccordionItem key={index} value={String(index)}>
              <AccordionControl>
                {t["com.myoxus.database.filter.group-label"]({
                  number: String(index + 1),
                })}
              </AccordionControl>
              <AccordionPanel>
                <Stack gap="sm">
                  <DatabaseFilterGroupEditor
                    depth={depth + 1}
                    group={child}
                    record={record}
                    tagOptions={tagOptions}
                    onChange={(nextChild) =>
                      onChange({
                        ...group,
                        groups: groups.map((candidate, candidateIndex) =>
                          candidateIndex === index ? nextChild : candidate,
                        ),
                      })
                    }
                  />
                  <Group justify="flex-end" gap="xs">
                    <IconButton
                      aria-label={t[
                        "com.myoxus.database.filter.move-group-up"
                      ]()}
                      disabled={index === 0}
                      size="small"
                      variant="plain"
                      onClick={() =>
                        onChange({
                          ...group,
                          groups: moveDatabaseFilterItem(groups, index, -1),
                        })
                      }
                    >
                      <ArrowUpSmallIcon />
                    </IconButton>
                    <IconButton
                      aria-label={t[
                        "com.myoxus.database.filter.move-group-down"
                      ]()}
                      disabled={index === groups.length - 1}
                      size="small"
                      variant="plain"
                      onClick={() =>
                        onChange({
                          ...group,
                          groups: moveDatabaseFilterItem(groups, index, 1),
                        })
                      }
                    >
                      <ArrowDownSmallIcon />
                    </IconButton>
                    <Button
                      size="xs"
                      variant="ghost"
                      prefix={<TrashIcon />}
                      onClick={() =>
                        onChange({
                          ...group,
                          groups: groups.filter(
                            (_, candidateIndex) => candidateIndex !== index,
                          ),
                        })
                      }
                    >
                      {t["Delete"]()}
                    </Button>
                  </Group>
                </Stack>
              </AccordionPanel>
            </AccordionItem>
          ))}
        </Accordion>
      ) : null}
    </Stack>
  );
}
