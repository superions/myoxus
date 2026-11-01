// SPDX-License-Identifier: AGPL-3.0-or-later

import { useI18n } from "@myoxus/i18n";
import { FormRow, FormSelect, Input, MyoxusText } from "@myoxus/ui-facade";

/** The native creation and source capture flows share destination/title inputs. */
export function TaskDestinationFields({
  projects,
  projectId,
  onProjectChange,
  title,
  onTitleChange,
  titleId,
  titleError,
  disabled,
  autoFocus,
  destinationLabel,
  titleLabel,
  audienceText,
  sourceInputId,
  sourceRequired,
  sourceError,
  include = ["destination", "audience", "title"],
}: {
  projects: { id: string; title: string; workspaceTasks?: boolean }[];
  projectId: string;
  onProjectChange: (value: string) => void;
  title: string;
  onTitleChange: (value: string) => void;
  titleId: string;
  titleError: boolean;
  disabled: boolean;
  autoFocus?: boolean;
  sourceInputId?: string;
  sourceRequired?: boolean;
  sourceError?: string;
  destinationLabel?: string;
  titleLabel?: string;
  audienceText?: string;
  include?: readonly ("destination" | "audience" | "title")[];
}) {
  const t = useI18n();
  return (
    <>
      {include.includes("destination") ? (
        <FormSelect
          data-testid="task-destination-select"
          data-assistant-input={sourceInputId}
          required={sourceRequired}
          error={sourceError}
          label={
            destinationLabel ?? t["com.myoxus.database.tasks.destination"]()
          }
          value={projectId || null}
          onChange={onProjectChange}
          data={projects.map((project) => ({
            value: project.id,
            label: project.workspaceTasks
              ? t["com.myoxus.database.tasks.workspace-tasks"]()
              : project.title,
          }))}
          placeholder={t["com.myoxus.database.tasks.destination"]()}
          allowDeselect={false}
          disabled={disabled}
        />
      ) : null}
      {include.includes("audience") ? (
        <MyoxusText tone="secondary">
          {audienceText ??
            t["com.myoxus.database.tasks.destination-audience"]()}
        </MyoxusText>
      ) : null}
      {include.includes("title") ? (
        <FormRow
          label={titleLabel ?? t.Title()}
          labelFor={titleId}
          error={
            sourceError ??
            (titleError
              ? t["com.myoxus.editor.embed.empty-title"]()
              : undefined)
          }
        >
          <Input
            data-assistant-input={sourceInputId}
            id={titleId}
            value={title}
            onChange={onTitleChange}
            required
            autoFocus={autoFocus}
            data-autofocus={autoFocus || undefined}
          />
        </FormRow>
      ) : null}
    </>
  );
}
