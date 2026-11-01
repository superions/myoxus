// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Checkbox,
  MyoxusText,
  Button,
  Textarea,
  NumberInput,
  Stack,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  gitGraphAttribute,
  gitGraphRuntimeText,
  gitGraphBranchName,
  type GitGraphReactHostProps,
} from "@virgultum/block-mermaid";
import {
  useGitGraphDraft,
  gitGraphDefaultAnchor,
  gitGraphDraftKey,
} from "./drafts";
import { GitGraphAnchorFields, GitGraphDraftFooter } from "./commit-popover";
export function GitGraphBranchForm({
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
    main = record?.kind === "header",
    name = main ? props.model.mainBranchName : (record?.reference?.value ?? ""),
    order = main
      ? props.model.mainBranchOrder
      : record
        ? Number(gitGraphAttribute(record, "order") ?? 0)
        : 0;
  const d = useGitGraphDraft(
      {
        name,
        order:
          record && !main && gitGraphAttribute(record, "order") === undefined
            ? null
            : order,
        continueOnBranch: false,
        anchor: gitGraphDefaultAnchor(props),
      },
      props,
    ),
    v = d.value,
    origin = record
      ? props.model.derivedGraph?.contexts.find(
          (ctx) => ctx.sourceKey === record.sourceKey,
        )?.head
      : null,
    head = props.model.derivedGraph?.finalContext.branchHeads.get(
      main
        ? props.model.mainBranchId
        : gitGraphRuntimeText(name, props.model.derivedGraph?.sanitization),
    ),
    label = (key: string | null | undefined) =>
      props.model.derivedGraph?.occurrences.find((c) => c.sourceKey === key)
        ?.sourceId || (key ? m.gitGraphGenerated() : "∅");
  const save = (preview = false) => {
    const r = sourceKey
      ? d.run(preview, "editGitGraphBranch", [
          sourceKey,
          {
            ...(v.name !== name ? { name: v.name } : {}),
            ...(!Object.is(
              v.order,
              record &&
                !main &&
                gitGraphAttribute(record, "order") === undefined
                ? null
                : order,
            )
              ? { order: v.order }
              : {}),
          },
        ])
      : d.run(preview, "createGitGraphBranch", [
          v.anchor,
          v.name,
          v.order,
          v.continueOnBranch,
        ]);
    if (!preview && !r.diagnostic) onClose();
  };
  return (
    <Stack onKeyDown={(e) => gitGraphDraftKey(e, () => save(), onClose)}>
      {!record ? (
        <GitGraphAnchorFields
          props={props}
          value={v.anchor}
          onChange={(a) => d.set("anchor", a)}
        />
      ) : null}
      {record ? (
        <MyoxusText>
          {m.gitGraphOrigin()}: {label(origin)} · {m.gitGraphHead()}:{" "}
          {label(head)} · {m.gitGraphActive()}:{" "}
          {gitGraphBranchName(
            props.model,
            props.model.derivedGraph?.finalContext.branch,
          )}
        </MyoxusText>
      ) : null}
      <Textarea
        autosize
        autoFocus
        data-autofocus
        label={m.erName()}
        value={v.name}
        disabled={props.readonly}
        onChange={(e) => d.set("name", e)}
      />
      {main && props.model.branches[0]?.referenceable === false ? (
        <MyoxusText>{m.gitGraphDiagnosticBranchUnreferenceable()}</MyoxusText>
      ) : null}
      <NumberInput
        label={m.gitGraphOrder()}
        value={v.order !== null && Number.isFinite(v.order) ? v.order : ""}
        disabled={props.readonly}
        onChange={(n) => d.set("order", n === "" ? null : Number(n))}
      />
      {!record ? (
        <Checkbox
          label={m.gitGraphContinue()}
          checked={v.continueOnBranch}
          disabled={props.readonly}
          onChange={(e) => d.set("continueOnBranch", e.target.checked)}
        />
      ) : null}
      {record ? (
        <Button
          disabled={
            props.readonly ||
            (main && props.model.branches[0]?.referenceable === false)
          }
          title={
            main && props.model.branches[0]?.referenceable === false
              ? m.gitGraphDiagnosticBranchUnreferenceable()
              : undefined
          }
          onClick={() => props.onParentIntent("checkout")}
        >
          {m.gitGraphCheckout()}
        </Button>
      ) : (
        <MyoxusText>{m.gitGraphBranchCheckout()}</MyoxusText>
      )}
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
