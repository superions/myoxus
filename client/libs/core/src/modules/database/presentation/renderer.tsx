// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type AssistantArtworkFragmentFragment as AssistantArtworkFragment,
  AssistantActionKind,
  AssistantArtworkRole,
  AssistantControlKind,
  AssistantInputControlKind,
  AssistantValueType,
  type AssistantActionFragmentFragment as AssistantActionFragment,
  type AssistantControlFragmentFragment as AssistantControlFragment,
  type AssistantGroupFragmentFragment as AssistantGroupFragment,
  type AssistantInputFragmentFragment as AssistantInputFragment,
  type AssistantPackageFragmentFragment as AssistantPackageFragment,
  type AssistantValueFragmentFragment as AssistantValueFragment,
} from "@myoxus/graphql";
import { desktopServerRequestUrl } from "@myoxus/desktop-api-contract";
import { useI18n } from "@myoxus/i18n";
import {
  Button,
  FormSelect,
  FormRow,
  Grid,
  Group,
  Input,
  MediaPreviewFrame,
  MediaPreviewImage,
  MultiSelect,
  MyoxusText,
  Notice,
  RadioCard,
  RadioCardGroup,
  RadioCardIndicator,
  SelectionCardGrid,
  Stack,
  Switch,
  Textarea,
} from "@myoxus/ui-facade";
import { Fragment, useRef, useState, type ReactNode } from "react";
import type { ServerMetadata } from "../../server/types";
import {
  assistantText,
  assistantValue,
  assistantVisible,
  visibleAssistantAnswers,
  type AssistantAnswers,
} from "./values";

import { AssistantTaskReferencesInput } from "./task-references-input";

export type AssistantInputAdapter = {
  input: AssistantInputFragment;
  control: AssistantControlFragment;
  value: AssistantValueFragment | undefined;
  disabled: boolean;
  testId?: string;
  error?: string;
  onChange: (value: AssistantValueFragment | undefined) => void;
};
export type AssistantNativeAdapters = {
  input?: (props: AssistantInputAdapter) => ReactNode | undefined;
  control?: (control: AssistantControlFragment) => ReactNode | undefined;
};

type Copy = ReturnType<typeof useI18n>;
export function assistantActionLabel(action: AssistantActionFragment, t: Copy) {
  if (action.label) return assistantText(action.label, t.language);
  switch (action.action) {
    case AssistantActionKind.Back:
      return t["common.back"]();
    case AssistantActionKind.Next:
      return t["common.next"]();
    case AssistantActionKind.Cancel:
      return t.Cancel();
    case AssistantActionKind.Close:
      return t["com.myoxus.peek-view-controls.close"]();
    case AssistantActionKind.Refresh:
      return t.Retry();
    case AssistantActionKind.Check:
      return t["com.myoxus.database.tasks.check-created"]();
    case AssistantActionKind.OpenCurrentRow:
      return t["com.myoxus.database.row.open-details"]();
    case AssistantActionKind.OpenRelatedRow:
      return t["com.myoxus.database.row.open-details"]();
    case AssistantActionKind.OpenProjectCreation:
    case AssistantActionKind.CreateProject:
      return t["com.myoxus.database.create.project-dialog.title"]();
    case AssistantActionKind.CreateWorkspace:
      return t["com.myoxus.nameWorkspace.button.create"]();
    case AssistantActionKind.CreateTask:
      return t.Create();
    case AssistantActionKind.CaptureTask:
      return t.Create();
    case AssistantActionKind.CreateSubtask:
      return t["com.myoxus.database.task-children.add"]();
    case AssistantActionKind.PrepareTaskPreparation:
      return t["com.myoxus.database.automation.personal-review"]();
    case AssistantActionKind.ConfigureTaskPreparation:
      return t["com.myoxus.database.automation.personal-enable"]();
    case AssistantActionKind.PrepareTaskMaintenance:
    case AssistantActionKind.PrepareTaskHandover:
    case AssistantActionKind.PrepareDocumentReview:
    case AssistantActionKind.PrepareDocuments:
      return t["common.next"]();
    case AssistantActionKind.StartTaskMaintenance:
    case AssistantActionKind.StartTaskHandover:
    case AssistantActionKind.RequestDocumentReview:
    case AssistantActionKind.ApplyDocuments:
      return t.Create();
    case AssistantActionKind.PrepareTaskMove:
      return t["com.myoxus.database.tasks.move-preview"]();
    case AssistantActionKind.CommitTaskMove:
      return t["com.myoxus.database.tasks.move-confirm"]();
  }
}

function AssistantInputControl(
  props: AssistantInputAdapter & { adapters: AssistantNativeAdapters },
) {
  const t = useI18n();
  const { input, control, value, onChange, disabled, adapters, testId, error } =
    props;
  const native = adapters.input?.(props);
  if (native !== undefined) return native;
  const label = assistantText(input.label, t.language);
  const description = input.description
    ? assistantText(input.description, t.language)
    : undefined;
  const options = input.choices.map((choice) => ({
    value: choice.id,
    label: assistantText(choice.label, t.language),
  }));
  const currentChoice = value?.choice ?? null;
  const text = value?.text ?? "";
  switch (control.control) {
    case AssistantInputControlKind.TaskReferences:
      return <AssistantTaskReferencesInput {...props} />;
    case AssistantInputControlKind.Text:
    case AssistantInputControlKind.Search:
      return (
        <Input
          data-assistant-input={input.id}
          error={error}
          data-testid={testId}
          label={label}
          description={description}
          required={input.required}
          disabled={disabled}
          value={text}
          onChange={(text) =>
            onChange(assistantValue(AssistantValueType.Text, { text }))
          }
        />
      );
    case AssistantInputControlKind.Multiline:
      return (
        <Textarea
          data-assistant-input={input.id}
          error={error}
          data-testid={testId}
          label={label}
          description={description}
          required={input.required}
          disabled={disabled}
          value={text}
          onChange={(text) =>
            onChange(assistantValue(AssistantValueType.Text, { text }))
          }
          autosize
        />
      );
    case AssistantInputControlKind.Toggle: {
      const toggle = (
        <Switch
          data-testid={testId}
          checked={value?.boolean ?? false}
          disabled={disabled}
          onChange={(boolean) =>
            onChange(assistantValue(AssistantValueType.Boolean, { boolean }))
          }
        >
          {label}
        </Switch>
      );
      return (
        <FormRow data-assistant-input={input.id} error={error}>
          {toggle}
        </FormRow>
      );
    }
    case AssistantInputControlKind.Select:
      return (
        <FormSelect
          data-assistant-input={input.id}
          error={error}
          data-testid={testId}
          label={label}
          description={description}
          required={input.required}
          disabled={disabled}
          data={options}
          value={currentChoice}
          onChange={(id) =>
            onChange(
              id
                ? assistantValue(AssistantValueType.Choice, { choice: id })
                : undefined,
            )
          }
          clearable={!input.required}
          onClear={() => onChange(undefined)}
        />
      );
    case AssistantInputControlKind.RadioCards:
      return (
        <RadioCardGroup
          data-assistant-input={input.id}
          error={error}
          data-testid={testId}
          label={label}
          description={description}
          value={currentChoice ?? ""}
          onChange={(id) =>
            onChange(
              id
                ? assistantValue(AssistantValueType.Choice, { choice: id })
                : undefined,
            )
          }
        >
          <SelectionCardGrid>
            {options.map((choice) => (
              <RadioCard
                key={choice.value}
                value={choice.value}
                aria-label={choice.label}
                data-testid={testId ? `${testId}-${choice.value}` : undefined}
                disabled={disabled}
              >
                <Group>
                  <RadioCardIndicator />
                  <MyoxusText>{choice.label}</MyoxusText>
                </Group>
              </RadioCard>
            ))}
          </SelectionCardGrid>
        </RadioCardGroup>
      );
    case AssistantInputControlKind.MultiSelect:
      return (
        <MultiSelect
          data-assistant-input={input.id}
          error={error}
          data-testid={testId}
          label={label}
          description={description}
          required={input.required}
          disabled={disabled}
          data={options}
          value={value?.choices ?? []}
          onChange={(choices) =>
            onChange(assistantValue(AssistantValueType.Choices, { choices }))
          }
        />
      );
    default:
      // Native controls require the consumer's existing scoped adapter. An
      // unavailable adapter is visible, never an empty successful form.
      return (
        <Notice tone="warning">
          {t["com.myoxus.database.tasks.managed-unavailable"]()}
        </Notice>
      );
  }
}

export function assistantControlKey(control: AssistantControlFragment) {
  return [
    control.kind,
    control.input,
    control.binding?.kind,
    control.binding?.roleKey,
    control.binding?.fieldKey,
    control.value,
    control.filter,
  ]
    .filter((part) => part !== null && part !== undefined)
    .join(":");
}

function AssistantArtworkPreview({
  artwork,
  server,
}: {
  artwork: AssistantArtworkFragment;
  server?: ServerMetadata | null;
}) {
  const t = useI18n();
  const [failed, setFailed] = useState(false);
  const frame = useRef<HTMLDivElement>(null);
  let url: string | undefined;
  if (server) {
    const target = new URL(artwork.url, server.baseUrl);
    if (target.origin === new URL(server.baseUrl).origin) {
      // Native images use the same registered server/cookie boundary as fetch;
      // relative API paths must not resolve against the Electron app origin.
      url = BUILD_CONFIG.isElectron
        ? desktopServerRequestUrl(server.id, target.pathname + target.search)
        : target.toString();
    }
  }
  const image =
    url && !failed ? (
      <MediaPreviewImage
        src={url}
        alt={assistantText(artwork.alternative, t.language)}
        onError={() => setFailed(true)}
      />
    ) : (
      <Stack>
        <MyoxusText tone="secondary">
          {t["com.myoxus.common.preview-unavailable"]()}
        </MyoxusText>
        {url ? (
          <Button
            type="button"
            onClick={() => {
              // Retry removes its button, so retain the shared preview focus owner.
              frame.current?.focus();
              setFailed(false);
            }}
          >
            {t.Retry()}
          </Button>
        ) : null}
      </Stack>
    );
  return (
    <>
      {artwork.role === AssistantArtworkRole.Illustration ? (
        <Stack
          ref={frame}
          role="group"
          tabIndex={-1}
          aria-label={assistantText(artwork.alternative, t.language)}
        >
          {image}
        </Stack>
      ) : (
        <MediaPreviewFrame
          ref={frame}
          role="group"
          tabIndex={-1}
          aria-label={assistantText(artwork.alternative, t.language)}
          aspectRatio={`${artwork.width} / ${artwork.height}`}
        >
          {image}
        </MediaPreviewFrame>
      )}
      {artwork.caption ? (
        <MyoxusText tone="secondary">
          {assistantText(artwork.caption, t.language)}
        </MyoxusText>
      ) : null}
    </>
  );
}

/** Native hosts keep their own group layout and controls; only the qualified
 * delivery overlay and its supplementary image feedback are shared. */
export function AssistantGroupArtwork({
  descriptor,
  stepId,
  groupId,
  server,
}: {
  descriptor: AssistantPackageFragment;
  stepId?: string;
  groupId: string;
  server?: ServerMetadata | null;
}) {
  return descriptor.artwork
    .filter((artwork) => artwork.step === stepId && artwork.group === groupId)
    .map((artwork) => (
      <AssistantArtworkPreview
        key={JSON.stringify([
          server?.id,
          server?.baseUrl,
          artwork.url,
          artwork.digest,
        ])}
        artwork={artwork}
        server={server}
      />
    ));
}

/** Only composition is shared. Controls continue to use their native revision,
 * authorization, draft and recovery owners through the consumer's adapters. */
export function AssistantGroups({
  groups,
  descriptor,
  answers,
  onAnswer,
  adapters,
  disabled = false,
  renderGroup,
  inputTestId,
  invalidInputs,
  stepId,
  artworkServer,
  onOpenDocumentSource,
  grouped = true,
}: {
  groups: readonly AssistantGroupFragment[];
  descriptor: AssistantPackageFragment;
  stepId?: string;
  artworkServer?: ServerMetadata | null;
  /** A value-first host may own spacing itself, including async native absence. */
  grouped?: boolean;
  onOpenDocumentSource?: (
    source: AssistantPackageFragment["documentSources"][number],
  ) => void;
  answers: AssistantAnswers;
  onAnswer?: (
    input: AssistantInputFragment,
    value: AssistantValueFragment | undefined,
  ) => void;
  adapters: AssistantNativeAdapters;
  disabled?: boolean;
  invalidInputs?: ReadonlySet<string>;
  inputTestId?: (input: AssistantInputFragment) => string | undefined;
  renderGroup?: (
    group: AssistantGroupFragment,
    children: ReactNode,
  ) => ReactNode;
}) {
  const t = useI18n();
  const normalized = visibleAssistantAnswers(descriptor, answers);
  return (
    <>
      {groups
        .filter((group) => assistantVisible(group.visibleWhen, normalized))
        .map((group) => {
          const controls = group.controls.map((control) => {
            if (control.kind !== AssistantControlKind.Input) {
              const native = adapters.control?.(control);
              return (
                <Fragment key={assistantControlKey(control)}>
                  {native === undefined ? (
                    <Notice tone="warning">
                      {t["com.myoxus.database.tasks.managed-unavailable"]()}
                    </Notice>
                  ) : (
                    native
                  )}
                </Fragment>
              );
            }
            const input = descriptor.inputs.find(
              (input) => input.id === control.input,
            );
            if (!input || !assistantVisible(input.visibleWhen, normalized))
              return null;
            return (
              <AssistantInputControl
                key={assistantControlKey(control)}
                input={input}
                error={
                  invalidInputs?.has(input.id)
                    ? t["com.myoxus.document-metadata.validation.required"]({
                        label: assistantText(input.label, t.language),
                      })
                    : undefined
                }
                testId={inputTestId?.(input)}
                control={control}
                value={answers[input.id]}
                disabled={disabled}
                onChange={(value) => onAnswer?.(input, value)}
                adapters={adapters}
              />
            );
          });
          const artwork = descriptor.artwork.filter(
            (item) => item.step === stepId && item.group === group.id,
          );
          const illustration = artwork.find(
            (item) => item.role === AssistantArtworkRole.Illustration,
          );
          const groupContents = (
            <>
              {group.title && !renderGroup ? (
                <MyoxusText>
                  {assistantText(group.title, t.language)}
                </MyoxusText>
              ) : null}
              {artwork
                .filter(
                  (item) => item.role !== AssistantArtworkRole.Illustration,
                )
                .map((item) => (
                  <AssistantArtworkPreview
                    key={JSON.stringify([
                      artworkServer?.id,
                      artworkServer?.baseUrl,
                      item.url,
                      item.digest,
                    ])}
                    artwork={item}
                    server={artworkServer}
                  />
                ))}
              {onOpenDocumentSource
                ? descriptor.documentSources
                    .filter(
                      (source) =>
                        source.step === stepId && source.group === group.id,
                    )
                    .map((source) => (
                      <Button
                        key={`${source.templateId}:${source.digest}`}
                        variant="secondary"
                        disabled={disabled}
                        onClick={() => onOpenDocumentSource(source)}
                      >
                        {group.title
                          ? assistantText(group.title, t.language)
                          : t["com.myoxus.rootAppSidebar.library"]()}
                      </Button>
                    ))
                : null}
              {controls}
            </>
          );
          const details = grouped ? (
            <Stack>{groupContents}</Stack>
          ) : (
            groupContents
          );
          // Authored illustrations share the group's controls; diagrams keep
          // their historical full-width preview and intrinsic aspect ratio.
          const content = illustration ? (
            <Grid align="center">
              <Grid.Col span={9}>{details}</Grid.Col>
              <Grid.Col span={3}>
                <AssistantArtworkPreview
                  key={JSON.stringify([
                    artworkServer?.id,
                    artworkServer?.baseUrl,
                    illustration.url,
                    illustration.digest,
                  ])}
                  artwork={illustration}
                  server={artworkServer}
                />
              </Grid.Col>
            </Grid>
          ) : (
            details
          );
          return (
            <Fragment key={group.id}>
              {renderGroup ? renderGroup(group, content) : content}
            </Fragment>
          );
        })}
    </>
  );
}

/** The authored primary form action owns the browser's implicit submit. A
 * submit button delegates exclusively to onSubmit, avoiding a second dispatch. */
export function assistantFormAction(
  actions: readonly AssistantActionFragment[],
  answers: AssistantAnswers,
) {
  return actions.find(
    (action) =>
      [
        AssistantActionKind.Next,
        AssistantActionKind.CreateWorkspace,
        AssistantActionKind.CreateProject,
        AssistantActionKind.CreateTask,
        AssistantActionKind.CaptureTask,
        AssistantActionKind.CreateSubtask,
        AssistantActionKind.PrepareDocuments,
        AssistantActionKind.ApplyDocuments,
        AssistantActionKind.PrepareTaskMaintenance,
        AssistantActionKind.StartTaskMaintenance,
        AssistantActionKind.PrepareTaskHandover,
        AssistantActionKind.StartTaskHandover,
        AssistantActionKind.PrepareDocumentReview,
        AssistantActionKind.RequestDocumentReview,
      ].includes(action.action) &&
      assistantVisible(action.visibleWhen, answers),
  );
}

export function AssistantActions({
  actions,
  answers,
  onAction,
  disabled,
  busy = false,
  testId,
  submitActionId,
  formId,
}: {
  actions: readonly AssistantActionFragment[];
  answers: AssistantAnswers;
  onAction: (action: AssistantActionFragment) => void;
  disabled?: (action: AssistantActionFragment) => boolean;
  busy?: boolean;
  testId?: (action: AssistantActionFragment) => string | undefined;
  submitActionId?: string;
  formId?: string;
}) {
  const t = useI18n();
  return (
    <Group justify="end">
      {actions
        .filter((action) => assistantVisible(action.visibleWhen, answers))
        .map((action) => (
          <Button
            key={action.id}
            type={action.id === submitActionId ? "submit" : "button"}
            form={action.id === submitActionId ? formId : undefined}
            variant={
              [
                AssistantActionKind.CreateWorkspace,
                AssistantActionKind.CreateProject,
                AssistantActionKind.CreateTask,
                AssistantActionKind.CreateSubtask,
                AssistantActionKind.CaptureTask,
                AssistantActionKind.CommitTaskMove,
                AssistantActionKind.PrepareDocuments,
                AssistantActionKind.ApplyDocuments,
                AssistantActionKind.PrepareTaskMaintenance,
                AssistantActionKind.StartTaskMaintenance,
                AssistantActionKind.PrepareTaskHandover,
                AssistantActionKind.StartTaskHandover,
                AssistantActionKind.PrepareDocumentReview,
                AssistantActionKind.RequestDocumentReview,
                AssistantActionKind.Next,
              ].includes(action.action)
                ? "primary"
                : "secondary"
            }
            data-testid={testId?.(action)}
            disabled={busy || disabled?.(action)}
            onClick={
              action.id === submitActionId ? undefined : () => onAction(action)
            }
          >
            {assistantActionLabel(action, t)}
          </Button>
        ))}
    </Group>
  );
}
