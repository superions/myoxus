// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  AssistantActionKind,
  AssistantInputTarget,
  AssistantValueType,
  AssistantFolderDestinationKind,
  AssistantProjectScaffoldKind,
  type AssistantActionFragmentFragment as AssistantAction,
  type AssistantPackageFragmentFragment as AssistantPackage,
  type PreparedProjectAssistantFragmentFragment as Prepared,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  FormSelect,
  Group,
  MyoxusText,
  RadioCard,
  RadioCardGroup,
  RadioCardIndicator,
  SearchInput,
  SelectionCardGrid,
  Input,
  LocalizedDateInput,
  Loading,
  OnboardingStep,
  Stack,
  Stepper,
  StepperStep,
  Table,
  TableBody,
  TableCell,
  TableRow,
} from "@myoxus/ui-facade";
import type { ReactNode, RefObject } from "react";
import type { useRegionalPreferences } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import type { WorkspaceFolderOption } from "@myoxus/core/modules/workspace-pages";
import { formatDateOnly } from "@myoxus/core/modules/database/model";
import {
  AssistantGroups,
  AssistantActions,
  assistantFormAction,
  type AssistantInputAdapter,
  type AssistantNativeAdapters,
} from "@myoxus/core/modules/database/presentation/renderer";
import {
  assistantInputIsPlaced,
  assistantVisible,
  assistantText,
  assistantValue,
  visibleAssistantAnswers,
  type AssistantAnswers,
} from "@myoxus/core/modules/database/presentation/values";

type Regional = ReturnType<typeof useRegionalPreferences>;
type ProjectCreationPlanReviewProps = {
  plan: Prepared | null;
  source: AssistantPackage | null;
  folders: readonly WorkspaceFolderOption[];
  regionalPreferences: Regional;
  people: (ids: string[]) => ReactNode;
};
type ProjectCreationInputOptions = {
  t: ReturnType<typeof useI18n>;
  regionalPreferences: Regional;
  folders: readonly WorkspaceFolderOption[];
  people: (props: AssistantInputAdapter) => ReactNode;
  folder?: (props: AssistantInputAdapter) => ReactNode;
};

export function ProjectCreationPlanReview({
  plan,
  source,
  folders,
  regionalPreferences,
  people,
}: ProjectCreationPlanReviewProps) {
  const t = useI18n();
  return plan ? (
    <Table data-testid="database-assistant-review">
      <TableBody>
        {source?.inputs.map((input) => {
          if (!source) return null;
          const planAnswers = Object.fromEntries(
            plan.answers.map((answer) => [answer.input, answer.value]),
          );
          if (
            !assistantInputIsPlaced(source, input, planAnswers) ||
            !assistantVisible(input.visibleWhen, planAnswers)
          )
            return null;
          const answer = plan.answers.find(
            (answer) => answer.input === input.id,
          )?.value;
          if (
            !answer &&
            input.target !== AssistantInputTarget.Folder &&
            input.target !== AssistantInputTarget.DefaultCurrency
          )
            return null;
          const plannedDate =
            input.target === AssistantInputTarget.StartDate
              ? plan.setup.startDate
              : plan.setup.endDate;
          const value =
            input.target === AssistantInputTarget.People
              ? plan.setup.people.length
                ? people(plan.setup.people)
                : t["com.myoxus.database.cell.empty"]()
              : input.target === AssistantInputTarget.StartDate ||
                  input.target === AssistantInputTarget.EndDate
                ? plannedDate
                  ? formatDateOnly(
                      plannedDate.start,
                      t.language,
                      regionalPreferences,
                    )
                  : t["com.myoxus.database.cell.empty"]()
                : input.target === AssistantInputTarget.Goal
                  ? (plan.setup.goal ?? t["com.myoxus.database.cell.empty"]())
                  : input.target === AssistantInputTarget.Scope
                    ? (plan.setup.scope ??
                      t["com.myoxus.database.cell.empty"]())
                    : input.target === AssistantInputTarget.DefaultCurrency
                      ? plan.defaultCurrency
                      : input.target === AssistantInputTarget.Folder
                        ? ((plan.folder?.kind ===
                          AssistantFolderDestinationKind.New
                            ? plan.folder.name
                            : folders.find(
                                (folder) => folder.value === plan.folder?.id,
                              )?.label) ??
                          t["com.myoxus.workspace-pages.move.no-folder"]())
                        : answer?.kind === AssistantValueType.Choice
                          ? assistantText(
                              input.choices.find(
                                (choice) => choice.id === answer.choice,
                              )?.label ?? input.label,
                              t.language,
                            )
                          : answer?.kind === AssistantValueType.Boolean
                            ? answer.boolean
                              ? t["com.myoxus.document-context.yes"]()
                              : t["com.myoxus.document-context.no"]()
                            : (answer?.text ??
                              t["com.myoxus.database.cell.empty"]());
          return (
            <TableRow key={input.id}>
              <TableCell>{assistantText(input.label, t.language)}</TableCell>
              <TableCell>{value}</TableCell>
            </TableRow>
          );
        })}
        {plan.documents.map((document) => (
          <TableRow key={`document-${document.source.componentId}`}>
            <TableCell>{document.title}</TableCell>
            <TableCell>
              {document.locale} · {document.source.version}
            </TableCell>
          </TableRow>
        ))}
        {plan.documentMetadata.map((document) => (
          <TableRow key={`document-metadata-${document.source.componentId}`}>
            <TableCell>{document.title}</TableCell>
            <TableCell>
              {document.locale} · {document.source.version}
            </TableCell>
          </TableRow>
        ))}
        {plan.setup.scaffold.map((entry) => (
          <TableRow key={`scaffold-${entry.id}`}>
            <TableCell>
              {entry.kind === AssistantProjectScaffoldKind.Phase
                ? t["com.myoxus.database.project.structure.phases"]()
                : t["com.myoxus.database.project.structure.milestones"]()}
            </TableCell>
            <TableCell>{assistantText(entry.title, t.language)}</TableCell>
          </TableRow>
        ))}
        <TableRow>
          <TableCell>
            {t["com.myoxus.database.project.structure.phases"]()}
          </TableCell>
          <TableCell data-testid="database-assistant-phase-count">
            {plan.counts.phases}
          </TableCell>
        </TableRow>
        <TableRow>
          <TableCell>
            {t["com.myoxus.database.project.structure.milestones"]()}
          </TableCell>
          <TableCell data-testid="database-assistant-milestone-count">
            {plan.counts.milestones}
          </TableCell>
        </TableRow>
        <TableRow>
          <TableCell colSpan={2}>
            {t["com.myoxus.database.template.sample-count"]({
              count: String(plan.counts.sampleRows),
            })}
          </TableCell>
        </TableRow>
        <TableRow>
          <TableCell colSpan={2}>
            {t["com.myoxus.database.create.assistant.explicit-task-count"]({
              count: String(plan.counts.explicitTasks),
            })}
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
  ) : (
    <Loading />
  );
}

export function projectCreationInputAdapter({
  t,
  regionalPreferences,
  folders,
  people,
  folder,
}: ProjectCreationInputOptions): NonNullable<AssistantNativeAdapters["input"]> {
  return (props) => {
    const { input, value, disabled, onChange, error } = props;
    if (input.target === AssistantInputTarget.People) return people(props);
    if (input.target === AssistantInputTarget.Folder && folder)
      return folder(props);
    if (
      input.target === AssistantInputTarget.StartDate ||
      input.target === AssistantInputTarget.EndDate
    )
      return (
        <LocalizedDateInput
          data-assistant-input={input.id}
          label={assistantText(input.label, t.language)}
          description={
            input.description
              ? assistantText(input.description, t.language)
              : undefined
          }
          required={input.required}
          error={error}
          locale={regionalPreferences.locale}
          value={
            typeof value?.date?.start === "string" ? value.date.start : null
          }
          disabled={disabled}
          clearable
          allowDeselect
          clearButtonProps={{
            "aria-label": t["com.myoxus.database.bulk.action.clear"](),
          }}
          onChange={(start) =>
            onChange(
              start
                ? assistantValue(AssistantValueType.Date, {
                    date: { start, end: null },
                  })
                : undefined,
            )
          }
        />
      );
    if (input.target !== AssistantInputTarget.Folder) return undefined;
    const destination = value?.folder;
    const existing = destination?.kind !== AssistantFolderDestinationKind.New;
    const updateFolder = (
      folder: NonNullable<typeof destination> | undefined,
    ) =>
      onChange(
        folder
          ? assistantValue(AssistantValueType.Folder, { folder })
          : undefined,
      );
    return (
      <Stack>
        <FormSelect
          label={t["com.myoxus.database.setup.folder.mode"]()}
          data-assistant-input={input.id}
          description={
            input.description
              ? assistantText(input.description, t.language)
              : undefined
          }
          data={[
            {
              value: "existing",
              label: t["com.myoxus.database.setup.folder.existing"](),
            },
            {
              value: "new",
              label: t["com.myoxus.rootAppSidebar.organize.new-folders"](),
            },
          ]}
          value={existing ? "existing" : "new"}
          disabled={disabled}
          onChange={(mode) =>
            updateFolder(
              mode === "new"
                ? {
                    kind: AssistantFolderDestinationKind.New,
                    id: null,
                    name: "",
                    parent: null,
                  }
                : undefined,
            )
          }
        />
        {existing ? (
          <FormSelect
            label={assistantText(input.label, t.language)}
            error={error}
            required={input.required}
            data={[...folders]}
            value={destination?.id ?? null}
            disabled={disabled}
            clearable
            onClear={() => onChange(undefined)}
            onChange={(id) =>
              updateFolder(
                id
                  ? {
                      kind: AssistantFolderDestinationKind.Existing,
                      id,
                      name: null,
                      parent: null,
                    }
                  : undefined,
              )
            }
          />
        ) : (
          <>
            <Input
              label={t["com.myoxus.database.setup.folder.name"]()}
              value={destination?.name ?? ""}
              disabled={disabled}
              required
              error={error}
              onChange={(name) =>
                updateFolder({
                  kind: AssistantFolderDestinationKind.New,
                  id: null,
                  name: name,
                  parent: destination?.parent ?? null,
                })
              }
            />
            <FormSelect
              label={t["com.myoxus.database.setup.folder.parent"]()}
              data={[...folders]}
              value={destination?.parent ?? null}
              disabled={disabled}
              clearable
              onClear={() =>
                updateFolder({
                  kind: AssistantFolderDestinationKind.New,
                  id: null,
                  name: destination?.name ?? "",
                  parent: null,
                })
              }
              onChange={(parent) =>
                updateFolder({
                  kind: AssistantFolderDestinationKind.New,
                  id: null,
                  name: destination?.name ?? "",
                  parent,
                })
              }
            />
          </>
        )}
      </Stack>
    );
  };
}

export function ProjectCreationGroups(
  props: Parameters<typeof AssistantGroups>[0],
) {
  return (
    <AssistantGroups
      {...props}
      inputTestId={(input) => {
        switch (input.target) {
          case AssistantInputTarget.Title:
            return "database-assistant-title";
          case AssistantInputTarget.Description:
            return "database-assistant-description";
          case AssistantInputTarget.PriorityPreset:
            return "database-assistant-priority";
          case AssistantInputTarget.ComplexityPreset:
            return "database-assistant-complexity";
          case AssistantInputTarget.StructurePreset:
            return "database-assistant-structure";
          case AssistantInputTarget.IncludeSamples:
            return "database-assistant-samples";
          default:
            return undefined;
        }
      }}
    />
  );
}

type ProjectCreationFormProps = {
  descriptor: AssistantPackage;
  stepId: string;
  answers: AssistantAnswers;
  formRef: RefObject<HTMLFormElement | null>;
  formId: string;
  busy: boolean;
  renderGroups: (
    groups: AssistantPackage["presentation"]["steps"][number]["groups"],
    stepId?: string,
  ) => ReactNode;
  onAction: (action: AssistantAction) => void;
  actionDisabled: (action: AssistantAction) => boolean;
  children?: ReactNode;
};

/** Controlled descriptor presentation. Native hosts retain authority, drafts,
 * validation, receipt state and scope fences; rendering never queries a target. */
export function ProjectCreationForm({
  descriptor,
  stepId,
  answers,
  formRef,
  formId,
  busy,
  renderGroups,
  onAction,
  actionDisabled,
  children,
}: ProjectCreationFormProps) {
  const t = useI18n();
  const step =
    descriptor.presentation.steps.find((step) => step.id === stepId) ??
    descriptor.presentation.steps[0];
  const stepIndex = descriptor.presentation.steps.indexOf(step);
  const normalized = visibleAssistantAnswers(descriptor, answers);
  return (
    <>
      <Stepper
        active={Math.max(0, stepIndex)}
        ariaLabel={t["com.myoxus.database.template.steps"]()}
        uiRole="database-creation-stepper"
      >
        {descriptor.presentation.steps.map((step) => (
          <StepperStep
            key={step.id}
            label={assistantText(step.title, t.language)}
          />
        ))}
      </Stepper>
      <form
        ref={formRef}
        id={formId}
        onSubmit={(event) => {
          event.preventDefault();
          const action = assistantFormAction(step.actions, normalized);
          if (action) onAction(action);
        }}
      >
        <OnboardingStep>{renderGroups(step.groups, step.id)}</OnboardingStep>
      </form>
      {children}
      <AssistantActions
        actions={step.actions.filter(
          (action) =>
            action.action !== AssistantActionKind.Check &&
            (action.action !== AssistantActionKind.Close ||
              !step.actions.some(
                (candidate) => candidate.action === AssistantActionKind.Cancel,
              )),
        )}
        submitActionId={assistantFormAction(step.actions, normalized)?.id}
        formId={formId}
        testId={(action) =>
          action.action === AssistantActionKind.Next
            ? "database-assistant-next"
            : action.action === AssistantActionKind.CreateProject
              ? "database-assistant-create"
              : undefined
        }
        answers={normalized}
        busy={busy}
        disabled={actionDisabled}
        onAction={onAction}
      />
    </>
  );
}

type ProjectCreationOfferingsProps = {
  packages: readonly AssistantPackage[];
  packageId: string | null;
  available: boolean;
  search: string;
  onSearch: (value: string) => void;
  onSelect: (id: string) => void;
  disabled: boolean;
  label?: string;
  searchable: boolean;
};
export function ProjectCreationOfferings({
  packages,
  packageId,
  available,
  search,
  onSearch,
  onSelect,
  disabled,
  label,
  searchable,
}: ProjectCreationOfferingsProps) {
  const t = useI18n();
  const visible = packages.filter((item) =>
    `${assistantText(item.name, t.language)} ${assistantText(item.description, t.language)}`
      .toLocaleLowerCase()
      .includes(search.trim().toLocaleLowerCase()),
  );
  return (
    <Stack>
      {searchable ? (
        <SearchInput
          value={search}
          onChange={onSearch}
          aria-label={t["com.myoxus.database.template.search.label"]()}
        />
      ) : null}
      <RadioCardGroup
        value={available ? (packageId ?? "") : ""}
        aria-label={label}
        onChange={onSelect}
      >
        <SelectionCardGrid>
          {visible.map((item) => (
            <RadioCard
              key={item.identity.id}
              value={item.identity.id}
              aria-label={assistantText(item.name, t.language)}
              disabled={disabled}
            >
              <Group>
                <RadioCardIndicator />
                <Stack>
                  <MyoxusText>
                    {assistantText(item.name, t.language)}
                  </MyoxusText>
                  <MyoxusText tone="secondary">
                    {assistantText(item.description, t.language)}
                  </MyoxusText>
                </Stack>
              </Group>
            </RadioCard>
          ))}
        </SelectionCardGrid>
      </RadioCardGroup>
    </Stack>
  );
}
