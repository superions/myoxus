// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Alert,
  Checkbox,
  Button,
  Group,
  NumberInput,
  Select,
  Stack,
  TagsInput,
  MyoxusTextInput,
  MyoxusText,
  Table,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@myoxus/ui-facade";
import {
  journeyTextValid,
  mermaidMessages as messages,
  type MermaidJourneyReactHostProps,
  type MermaidJourneySection,
  type MermaidJourneyStep,
  type MermaidJourneyModel,
  type JourneyCommand,
} from "@virgultum/block-mermaid";
import { useEffect, useLayoutEffect, useState } from "react";
import type { JourneyDraft } from "./drafts";
/** Kept only for a conflicting open form; never a persisted model or a force-write basis. */
export type JourneyStepFormDraft = {
  basis: string;
  label: string;
  score: number | string;
  actors: string[];
  actorsChanged: boolean;
  removeTail: boolean;
  section: string;
};
export function JourneyStepPopover({
  props,
  node,
  data = false,
  onClose,
  onPreview,
  draft,
  onDraftApply,
  onDraftPreview,
  initialForm,
  onFormDraft,
}: {
  initialForm?: JourneyStepFormDraft;
  onFormDraft?: (draft: JourneyStepFormDraft) => void;
  props: MermaidJourneyReactHostProps;
  node?: MermaidJourneySection | MermaidJourneyStep;
  data?: boolean;
  onClose: () => void;
  onPreview: (model: MermaidJourneyModel | undefined) => void;
  draft?: JourneyDraft;
  onDraftApply?: (label: string, score: number, actors: string[]) => void;
  onDraftPreview?: (label: string, score: number, actors: string[]) => void;
}) {
  const [basis] = useState(
    initialForm?.basis ?? draft?.source ?? props.model.sourceDocument.source,
  );
  const step = node && "score" in node ? node : undefined;
  const [label, setLabel] = useState(
    initialForm?.label ??
      draft?.label ??
      step?.label ??
      (node as MermaidJourneySection | undefined)?.title ??
      "",
  );
  const [score, setScore] = useState<number | string>(
    initialForm?.score ?? draft?.score ?? step?.score ?? 3,
  );
  const [actors, setActors] = useState<string[]>(
    initialForm?.actors ?? draft?.actors ?? step?.actors.filter(Boolean) ?? [],
  );
  const [actorsChanged, setActorsChanged] = useState(
    initialForm?.actorsChanged ?? false,
  );
  const [removeTail, setRemoveTail] = useState(
    initialForm?.removeTail ?? false,
  );
  const losesTail = Boolean(step?.tail && actorsChanged && !actors.length);
  const [section, setSection] = useState(
    initialForm?.section ?? draft?.sectionId ?? step?.sectionId ?? "",
  );
  const [notice, setNotice] = useState<string>();
  useLayoutEffect(() => {
    onFormDraft?.({
      basis,
      label,
      score,
      actors,
      actorsChanged,
      removeTail,
      section,
    });
  }, [
    basis,
    label,
    score,
    actors,
    actorsChanged,
    removeTail,
    section,
    onFormDraft,
  ]);
  const readonly =
    props.readonly || props.model.ambiguous || Boolean(node && !node.writable);
  const invalid =
    (losesTail && !removeTail) ||
    !journeyTextValid(label) ||
    Boolean(
      (step || draft?.kind === "step") &&
      (!Number.isFinite(Number(score)) ||
        score === "" ||
        (actorsChanged && actors.some((a) => !journeyTextValid(a, true)))),
    );
  const commands: JourneyCommand[] = node
    ? [
        ...(label !== ("label" in node ? node.label : node.title)
          ? [{ type: "rename" as const, id: node.id, label }]
          : []),
        ...(step && !Object.is(Number(score), step.score)
          ? [{ type: "score" as const, id: step.id, value: Number(score) }]
          : []),
        ...(step && actorsChanged
          ? [
              {
                type: "actors" as const,
                id: step.id,
                value: actors,
                ...(losesTail && removeTail
                  ? { removeTail: true as const }
                  : {}),
              },
            ]
          : []),
        ...(step && section !== step.sectionId
          ? [{ type: "move-step" as const, id: step.id, sectionId: section }]
          : []),
      ]
    : [];
  const signature = JSON.stringify(commands);
  useEffect(() => {
    if (draft && !invalid && !readonly)
      onDraftPreview?.(label, Number(score), actors);
    if (!node || invalid || readonly) {
      onPreview(undefined);
      return;
    }
    const result = props.onPreviewCommand(commands, basis);
    onPreview(result.changed ? result.model : undefined);
  }, [
    signature,
    JSON.stringify([label, score, actors]),
    invalid,
    readonly,
    basis,
    props.model.sourceDocument.source,
  ]);
  return (
    <Stack>
      {data && node ? (
        <Table>
          <TableBody>
            <TableRow>
              <TableHead>{messages.journeySection()}</TableHead>
              <TableCell>
                {step
                  ? props.model.sections.find((s) => s.id === step.sectionId)
                      ?.title
                  : (node as MermaidJourneySection).title}
              </TableCell>
            </TableRow>
            <TableRow>
              <TableHead>{messages.journeyOccurrences()}</TableHead>
              <TableCell>
                {step
                  ? step.actors.length
                  : props.model.steps.filter((s) => s.sectionId === node.id)
                      .length}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      ) : null}
      {/* The retained orphan form is already anchored in its host conflict alert. */}
      {notice && !initialForm ? <Alert>{notice}</Alert> : null}
      <MyoxusTextInput
        label={
          step || draft?.kind === "step"
            ? messages.journeyStep()
            : messages.journeySection()
        }
        value={label}
        readOnly={readonly}
        onChange={setLabel}
      />
      {step || draft?.kind === "step" ? (
        <>
          {!readonly ? (
            <Group>
              {[1, 2, 3, 4, 5].map((v) => (
                <Button
                  key={v}
                  variant={Number(score) === v ? "primary" : "plain"}
                  disabled={readonly}
                  onClick={() => setScore(v)}
                >
                  {v}
                </Button>
              ))}
            </Group>
          ) : null}
          <NumberInput
            label={messages.journeyScore()}
            value={Number.isFinite(Number(score)) ? score : ""}
            onChange={setScore}
            readOnly={readonly}
            hideControls={readonly}
          />
          <TagsInput
            label={messages.journeyActors()}
            value={actors}
            allowDuplicates
            data={[
              ...new Set(
                props.model.steps.flatMap((s) => s.actors).filter(Boolean),
              ),
            ].sort()}
            readOnly={readonly}
            onChange={(v) => {
              setActors(v);
              setActorsChanged(true);
              setRemoveTail(false);
            }}
          />
          {losesTail ? (
            <Checkbox
              label={messages.journeyRemoveActorTail()}
              checked={removeTail}
              disabled={readonly}
              onChange={(event) => setRemoveTail(event.currentTarget.checked)}
            />
          ) : null}
          {readonly ? (
            <MyoxusText>
              {messages.journeySection()}:{" "}
              {props.model.sections.find((s) => s.id === section)?.title ||
                messages.journeyUnnamed()}
            </MyoxusText>
          ) : (
            <Select
              label={messages.journeySection()}
              value={section}
              disabled={readonly || Boolean(draft)}
              onChange={setSection}
              data={props.model.sections.map((s) => ({
                value: s.id,
                label: s.title || messages.journeyUnnamed(),
              }))}
            />
          )}
          {step?.actors.some((a) => !a) && !actorsChanged ? (
            <Alert>{messages.journeyActorSlot()}</Alert>
          ) : null}
        </>
      ) : null}
      {invalid ? <Alert>{messages.journeyInvalidValue()}</Alert> : null}
      <Group>
        <Button variant="plain" onClick={onClose}>
          {messages.cancel()}
        </Button>
        {!readonly ? (
          <Button
            disabled={invalid}
            onClick={() => {
              if (draft) {
                onDraftApply?.(label, Number(score), actors);
                return;
              }
              const result = props.onCommand(commands, basis);
              if (result.changed || result.reason === "no-change") onClose();
              else
                setNotice(
                  result.reason === "conflict"
                    ? messages.ganttDiagnosticConflict()
                    : result.reason === "invalid"
                      ? messages.journeyInvalidValue()
                      : messages.ganttCommandRejected(),
                );
            }}
          >
            {messages.architectureApply()}
          </Button>
        ) : null}
      </Group>
    </Stack>
  );
}
