import { useEffect, useRef, useState } from "react";
import { ChevronUpIcon, ChevronDownIcon, DeleteIcon } from "@myoxus/icons";
// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Accordion,
  AccordionItem,
  AccordionControl,
  AccordionPanel,
  Alert,
  Button,
  IconButton,
  Group,
  MyoxusText,
  MyoxusTextInput,
  Popover,
  PopoverTarget,
  PopoverContent,
  Select,
  Textarea,
  Stack,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  gitGraphBranchName,
  gitGraphAttribute,
  nextGitGraphExplicitCommitId,
  gitGraphContextAtAnchor,
  GITGRAPH_TYPES,
  type GitGraphReactHostProps,
  type GitGraphInsertAnchor,
  type GitGraphRecord,
  type GitGraphRepairHostProps,
} from "@virgultum/block-mermaid";
import {
  useGitGraphDraft,
  gitGraphDefaultAnchor,
  gitGraphDraftKey,
} from "./drafts";
export function GitGraphAnchorFields({
  props,
  value,
  onChange,
  allowBeforeHeader = false,
}: {
  props: GitGraphReactHostProps;
  value: GitGraphInsertAnchor;
  /** Comments may precede the header; executable statements may not. */
  allowBeforeHeader?: boolean;
  onChange: (next: GitGraphInsertAnchor) => void;
}) {
  const records = props.model.sourceDocument!.records.filter((r) =>
      [
        "header",
        "commit",
        "branch",
        "checkout",
        "merge",
        "cherry-pick",
      ].includes(r.kind),
    ),
    key = value.sourceKey,
    record = key
      ? props.model.sourceDocument!.records.find((r) => r.sourceKey === key)
      : null;
  const context = gitGraphContextAtAnchor(props.model, value);
  const head = context?.head
    ? props.model.derivedGraph?.occurrences.find(
        (c) => c.sourceKey === context.head,
      )
    : null;
  return (
    <Stack>
      <Select
        label={m.gitGraphAnchor()}
        value={key ?? "end"}
        data={[
          { value: "end", label: m.gitGraphSourceEnd() },
          ...records.map((r) => ({
            value: r.sourceKey,
            label:
              r.kind === "header"
                ? `${r.range.line} · ${m.sequenceBranch()} · ${props.model.mainBranchName}`
                : `${r.range.line} · ${r.kind} · ${r.reference?.value ?? gitGraphAttribute(r, "id") ?? gitGraphAttribute(r, "message") ?? ""}`,
          })),
        ]}
        onChange={(key) =>
          onChange({
            ...value,
            sourceKey: key === "end" ? null : key,
            position:
              !allowBeforeHeader &&
              records.find((r) => r.sourceKey === key)?.kind === "header"
                ? "after"
                : value.position,
          })
        }
      />
      <Select
        label={m.sequencePosition()}
        value={value.position}
        data={[
          ...(allowBeforeHeader || record?.kind !== "header"
            ? [{ value: "before", label: m.sequenceBefore() }]
            : []),
          { value: "after", label: m.sequenceAfter() },
        ]}
        onChange={(position) =>
          onChange({
            ...value,
            position: position === "before" ? "before" : "after",
          })
        }
      />
      <MyoxusText>
        {gitGraphBranchName(props.model, context?.branch)} · {m.gitGraphHead()}:{" "}
        {head?.sourceId || head?.kind || "∅"}
      </MyoxusText>
    </Stack>
  );
}
export type GitGraphTagDraft = {
  key: string;
  sourceKey?: string;
  value: string;
};
export const gitGraphTagDrafts = (
  record: GitGraphRecord | null | undefined,
): GitGraphTagDraft[] =>
  record?.attributes
    .filter((a) => a.name === "tag")
    .map((a) => ({
      key: a.sourceKey,
      sourceKey: a.sourceKey,
      value: a.value,
    })) ?? [];
export function GitGraphTags({
  value,
  onChange,
  readonly,
  activeAttributeKey,
}: {
  activeAttributeKey?: string;
  value: readonly GitGraphTagDraft[];
  onChange: (tags: GitGraphTagDraft[]) => void;
  readonly: boolean;
}) {
  return (
    <Stack>
      {value.map((tag, index) => (
        <Group key={tag.key}>
          <Textarea
            autosize
            autoFocus={
              activeAttributeKey !== undefined &&
              tag.sourceKey === activeAttributeKey
            }
            data-autofocus={
              (activeAttributeKey !== undefined &&
                tag.sourceKey === activeAttributeKey) ||
              undefined
            }
            aria-label={m.selectedC4Tags()}
            value={tag.value}
            disabled={readonly}
            onChange={(e) =>
              onChange(
                value.map((t, i) => (i === index ? { ...t, value: e } : t)),
              )
            }
          />
          <IconButton
            tooltip={m.sequenceBefore()}
            disabled={readonly || index === 0}
            aria-label={m.sequenceBefore()}
            onClick={() => {
              const tags = [...value];
              [tags[index - 1], tags[index]] = [tags[index]!, tags[index - 1]!];
              onChange(tags);
            }}
          >
            <ChevronUpIcon />
          </IconButton>
          <IconButton
            tooltip={m.sequenceAfter()}
            disabled={readonly || index === value.length - 1}
            aria-label={m.sequenceAfter()}
            onClick={() => {
              const tags = [...value];
              [tags[index + 1], tags[index]] = [tags[index]!, tags[index + 1]!];
              onChange(tags);
            }}
          >
            <ChevronDownIcon />
          </IconButton>
          <IconButton
            tooltip={m.visualDelete()}
            aria-label={m.visualDelete()}
            disabled={readonly}
            onClick={() => onChange(value.filter((_, i) => i !== index))}
          >
            <DeleteIcon />
          </IconButton>
        </Group>
      ))}
      <Button
        disabled={readonly}
        onClick={() =>
          onChange([...value, { key: crypto.randomUUID(), value: "" }])
        }
      >
        {m.selectedC4Tags()}
      </Button>
    </Stack>
  );
}
export function GitGraphDraftFooter({
  props,
  diagnostic,
  impact,
  preview,
  apply,
  cancel,
  confirmationOnly = false,
}: {
  confirmationOnly?: boolean;
  props: GitGraphReactHostProps;
  diagnostic?: string;
  impact?: import("@virgultum/block-mermaid").GitGraphImpact[];
  preview: () => void;
  apply: () => void;
  cancel: () => void;
}) {
  return (
    <Stack>
      {diagnostic ? (
        <Alert
          color={
            props.readonly || props.displayOnly ? undefined : "myoxusError"
          }
        >
          {diagnostic}
        </Alert>
      ) : null}
      {impact?.length ? (
        <Stack>
          <MyoxusText>{m.gitGraphImpact()}</MyoxusText>
          {impact.map((i) => (
            <MyoxusText key={i.sourceKey}>
              {
                props.model.sourceDocument!.records.find(
                  (r) => r.sourceKey === i.sourceKey,
                )?.range.line
              }{" "}
              {"blockedByLine" in i ? (
                <>
                  · {i.beforeReferences.join(", ")} ·{" "}
                  {m.gitGraphImpactBlocked(i.blockedByLine)}
                </>
              ) : (
                <>
                  · {i.beforeBranchLabel} → {i.afterBranchLabel} ·{" "}
                  {m.gitGraphHead()}: {i.beforeHeadLabel} → {i.afterHeadLabel} ·{" "}
                  {i.beforeParentLabels.join(", ")} →{" "}
                  {i.afterParentLabels.join(", ")} ·{" "}
                  {i.beforeReferences.join(", ")} →{" "}
                  {i.afterReferences.join(", ")}
                </>
              )}
            </MyoxusText>
          ))}
        </Stack>
      ) : null}
      <Group>
        <Button
          disabled={props.readonly || props.displayOnly}
          onClick={preview}
        >
          {m.sequencePreview()}
        </Button>
        {!confirmationOnly ? (
          <Button
            disabled={props.readonly || props.displayOnly}
            onClick={apply}
          >
            {m.sequenceApply()}
          </Button>
        ) : null}
        {!confirmationOnly ? (
          <Button onClick={cancel}>{m.cancel()}</Button>
        ) : null}
      </Group>
    </Stack>
  );
}
export function GitGraphCommitForm({
  props,
  sourceKey,
  onClose,
}: {
  props: GitGraphReactHostProps;
  sourceKey?: string;
  onClose: () => void;
}) {
  const record = sourceKey
      ? props.model.sourceDocument!.records.find(
          (r) => r.sourceKey === sourceKey,
        )
      : null,
    commit = sourceKey
      ? props.model.derivedGraph?.occurrences.find(
          (c) => c.sourceKey === sourceKey,
        )
      : null;
  const d = useGitGraphDraft(
      {
        id: record ? (gitGraphAttribute(record, "id") ?? "") : "",
        makeExplicit: false,
        message: record ? (gitGraphAttribute(record, "message") ?? "") : "",
        type: record
          ? (gitGraphAttribute(record, "type") ?? "NORMAL")
          : "NORMAL",
        tags: gitGraphTagDrafts(record),
        anchor: gitGraphDefaultAnchor(props),
      },
      props,
    ),
    v = d.value;
  const save = (preview = false) => {
    const result = sourceKey
      ? d.run(preview, "editGitGraphCommit", [
          sourceKey,
          {
            ...(record &&
            (record.attributes.some((a) => a.name === "id") ||
              v.makeExplicit) &&
            v.id !== gitGraphAttribute(record, "id")
              ? { id: v.id }
              : {}),
            ...(v.message !==
            (record ? (gitGraphAttribute(record, "message") ?? "") : "")
              ? { message: v.message }
              : {}),
            ...(v.type !==
            (record
              ? (gitGraphAttribute(record, "type") ?? "NORMAL")
              : "NORMAL")
              ? { type: v.type as "NORMAL" | "HIGHLIGHT" | "REVERSE" }
              : {}),
            ...(JSON.stringify(v.tags) !==
            JSON.stringify(gitGraphTagDrafts(record))
              ? { tags: v.tags }
              : {}),
          },
        ])
      : d.run(preview, "addGitGraphCommit", [
          v.anchor,
          {
            id: v.id,
            message: v.message,
            type: v.type as "NORMAL" | "HIGHLIGHT" | "REVERSE",
            tags: v.tags.map((t) => t.value),
          },
        ]);
    if (!preview && !result.diagnostic) onClose();
  };
  return (
    <Stack onKeyDown={(e) => gitGraphDraftKey(e, () => save(), onClose)}>
      {record ? null : (
        <GitGraphAnchorFields
          props={props}
          value={v.anchor}
          onChange={(a) => d.set("anchor", a)}
        />
      )}
      <Textarea
        autosize
        label={m.sequenceId()}
        data-autofocus={
          !record ||
          props.selected?.role === "id" ||
          props.selected?.role === "commit" ||
          undefined
        }
        autoFocus={
          !record ||
          props.selected?.role === "id" ||
          props.selected?.role === "commit"
        }
        disabled={
          props.readonly ||
          (!!record &&
            !v.makeExplicit &&
            !record.attributes.some((a) => a.name === "id"))
        }
        value={v.id}
        onChange={(e) => d.set("id", e)}
      />
      {record &&
      !v.makeExplicit &&
      !record.attributes.some((a) => a.name === "id") ? (
        <Button
          disabled={props.readonly}
          onClick={() => {
            // Promotion is a draft so its ID/reference impact can use the
            // same Preview/Apply transaction as every other attribute change.
            d.set("id", nextGitGraphExplicitCommitId(props.model));
            d.set("makeExplicit", true);
          }}
        >
          {m.gitGraphExplicit()}
        </Button>
      ) : null}
      <Textarea
        autosize
        label={m.sequenceMessage()}
        autoFocus={props.selected?.role === "message"}
        data-autofocus={props.selected?.role === "message" || undefined}
        disabled={props.readonly}
        value={v.message}
        onChange={(e) => d.set("message", e)}
      />
      <Select
        label={m.erType()}
        disabled={props.readonly}
        value={v.type}
        data={GITGRAPH_TYPES.map((value) => ({ value, label: value }))}
        onChange={(type) => d.set("type", type ?? "NORMAL")}
      />
      <GitGraphTags
        activeAttributeKey={props.selected?.attributeKey}
        value={v.tags}
        onChange={(tags) => d.set("tags", tags)}
        readonly={props.readonly}
      />
      {record ? (
        <GitGraphAttributeOccurrences
          props={props}
          record={record}
          onClose={onClose}
        />
      ) : null}
      {commit ? (
        <MyoxusText>
          {gitGraphBranchName(props.model, commit.branchId)} ·{" "}
          {m.gitGraphHead()}:{" "}
          {commit.executionParents
            .map((key) => {
              const parent = props.model.derivedGraph?.occurrences.find(
                (candidate) => candidate.sourceKey === key,
              );
              return parent ? parent.sourceId || m.gitGraphGenerated() : "∅";
            })
            .join(", ")}
        </MyoxusText>
      ) : null}
      <GitGraphDraftFooter
        props={props}
        diagnostic={d.diagnostic}
        impact={d.feedback?.impact}
        preview={() => save(true)}
        apply={() => save()}
        cancel={onClose}
      />
    </Stack>
  );
}

/** Shadowed scalars are Source slots, not a second effective form. Each explicit
 * operation enters the same checked command/preview port as the main fields. */
export function GitGraphAttributeOccurrences({
  props,
  record,
  onClose,
}: {
  props: GitGraphReactHostProps;
  record: GitGraphRecord;
  onClose: () => void;
}) {
  const attributes = record.attributes.filter((a) => a.name !== "tag");
  if (!attributes.some((a) => !a.effective)) return null;
  return (
    <Accordion>
      <AccordionItem value="occurrences">
        <AccordionControl>{m.gitGraphOccurrences()}</AccordionControl>
        <AccordionPanel>
          <Stack>
            {attributes.map((a) => (
              <GitGraphAttributeOccurrence
                key={a.sourceKey}
                props={props}
                record={record}
                attribute={a}
                onClose={onClose}
              />
            ))}
          </Stack>
        </AccordionPanel>
      </AccordionItem>
    </Accordion>
  );
}
function GitGraphAttributeOccurrence({
  props,
  record,
  attribute: a,
  onClose,
}: {
  props: GitGraphReactHostProps;
  record: GitGraphRecord;
  attribute: GitGraphRecord["attributes"][number];
  onClose: () => void;
}) {
  const d = useGitGraphDraft({ value: a.value }, props);
  const save = (value: string | null, preview = false) => {
    const r = d.run(preview, "editGitGraphAttributeOccurrence", [
      record.sourceKey,
      a.sourceKey,
      value,
    ]);
    if (!preview && !r.diagnostic) onClose();
  };
  return (
    <Stack>
      <MyoxusTextInput
        label={`${a.name} · ${a.effective ? m.gitGraphEffective() : m.gitGraphShadowed()}`}
        value={d.value.value}
        disabled={props.readonly}
        onChange={(v) => d.set("value", v)}
      />
      <GitGraphDraftFooter
        props={props}
        diagnostic={d.diagnostic}
        impact={d.feedback?.impact}
        preview={() => save(d.value.value, true)}
        apply={() => save(d.value.value)}
        cancel={onClose}
      />
      <Button disabled={props.readonly} onClick={() => save(null)}>
        {m.visualDelete()}
      </Button>
    </Stack>
  );
}

/** Only this current-Source record can repair a duplicate/render error. The
 * retained chart remains readonly, with no historical glyph-to-writer path. */
export function GitGraphSourceRepair({
  props,
}: {
  props: GitGraphRepairHostProps;
}) {
  const cancel = useRef(props.onCancelPreview);
  cancel.current = props.onCancelPreview;
  useEffect(
    () => () => cancel.current(),
    [props.sourceBasis, props.readonly, props.viewportIdentity],
  );
  return (
    <Stack>
      {props.diagnostics.map((d) => (
        <Stack key={`${d.sourceKey}:${d.code}`}>
          <Alert
            color={d.severity === "error" ? "myoxusError" : "myoxusWarning"}
          >
            {d.message}
          </Alert>
          {d.stage === "render" && d.severity === "error"
            ? props.model
                .sourceDocument!.records.filter(
                  (r) =>
                    ["commit", "merge"].includes(r.kind) &&
                    (r.sourceKey === d.sourceKey ||
                      props.model.derivedGraph?.occurrences.some(
                        (c) => c.sourceKey === r.sourceKey && c.shadowed,
                      )),
                )
                .map((r) => (
                  <GitGraphRepairRecord
                    key={r.sourceKey}
                    props={props}
                    record={r}
                  />
                ))
            : null}
        </Stack>
      ))}
    </Stack>
  );
}
function GitGraphRepairRecord({
  props,
  record,
}: {
  props: GitGraphRepairHostProps;
  record: GitGraphRecord;
}) {
  const [id, setId] = useState(gitGraphAttribute(record, "id") ?? ""),
    [feedback, setFeedback] = useState<
      import("@virgultum/block-mermaid").GitGraphFeedback | null
    >(null),
    [open, setOpen] = useState(false);
  const { sourceBasis, readonly, onCancelPreview } = props;
  useEffect(() => {
    setOpen(false);
    onCancelPreview();
  }, [sourceBasis, readonly, onCancelPreview]);
  const apply = (preview: boolean) => {
    const result = props.onRename(
      record.sourceKey,
      id,
      props.sourceBasis,
      preview,
    );
    setFeedback(result);
    if (!preview && !result.diagnostic) setOpen(false);
  };
  return (
    <Popover
      trapFocus
      fitViewport
      opened={open}
      onChange={(v) => {
        setOpen(v);
        if (!v) props.onCancelPreview();
      }}
    >
      <PopoverTarget>
        <Button disabled={props.readonly} onClick={() => setOpen((v) => !v)}>
          {record.range.line} ·{" "}
          {gitGraphAttribute(record, "id") || m.gitGraphGenerated()}
        </Button>
      </PopoverTarget>
      <PopoverContent>
        <Stack
          onKeyDown={(e) =>
            gitGraphDraftKey(
              e,
              () => apply(false),
              () => {
                setOpen(false);
                props.onCancelPreview();
              },
            )
          }
        >
          <MyoxusTextInput
            label={m.sequenceId()}
            value={id}
            onChange={(v) => {
              props.onCancelPreview();
              setFeedback(null);
              setId(v);
            }}
          />
          {feedback?.diagnostic ? <Alert>{feedback.diagnostic}</Alert> : null}
          {feedback?.impact?.map((i) => (
            <MyoxusText key={i.sourceKey}>
              {"blockedByLine" in i ? (
                m.gitGraphImpactBlocked(i.blockedByLine)
              ) : (
                <>
                  {i.beforeReferences.join(", ")} →{" "}
                  {i.afterReferences.join(", ")} · {i.beforeHeadLabel} →{" "}
                  {i.afterHeadLabel}
                </>
              )}
            </MyoxusText>
          ))}
          <Group>
            <Button onClick={() => apply(true)}>{m.sequencePreview()}</Button>
            <Button onClick={() => apply(false)}>{m.sequenceApply()}</Button>
            <Button
              onClick={() => {
                props.onCancelPreview();
                setOpen(false);
              }}
            >
              {m.cancel()}
            </Button>
          </Group>
        </Stack>
      </PopoverContent>
    </Popover>
  );
}
