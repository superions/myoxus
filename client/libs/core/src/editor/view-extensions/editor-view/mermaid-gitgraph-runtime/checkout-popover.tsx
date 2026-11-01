// SPDX-License-Identifier: AGPL-3.0-or-later
import { MyoxusText, Select, Stack } from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  gitGraphContextAtAnchor,
  gitGraphBranchName,
  gitGraphReferenceRuntimeValue,
  type GitGraphReactHostProps,
} from "@virgultum/block-mermaid";
import {
  useGitGraphDraft,
  gitGraphDefaultAnchor,
  gitGraphDraftKey,
} from "./drafts";
import { GitGraphAnchorFields, GitGraphDraftFooter } from "./commit-popover";
export function GitGraphCheckoutForm({
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
    d = useGitGraphDraft(
      {
        branch:
          props.model.branches.find(
            (b) =>
              b.id ===
              (record
                ? gitGraphReferenceRuntimeValue(
                    record,
                    props.model.derivedGraph?.sanitization,
                  )
                : (props.selected?.branch ??
                  props.model.derivedGraph?.finalContext.branch)),
          )?.sourceKey ?? "",
        anchor: gitGraphDefaultAnchor(props),
      },
      props,
    ),
    v = d.value,
    context = gitGraphContextAtAnchor(
      props.model,
      record ? { sourceKey: record.sourceKey, position: "before" } : v.anchor,
    );
  const save = (preview = false) => {
    const result = sourceKey
      ? d.run(preview, "editGitGraphCheckout", [
          sourceKey,
          { sourceKey: v.branch },
        ])
      : d.run(preview, "createGitGraphCheckout", [
          v.anchor,
          { sourceKey: v.branch },
        ]);
    if (!preview && !result.diagnostic) onClose();
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
      <MyoxusText>
        {m.gitGraphActive()}: {gitGraphBranchName(props.model, context?.branch)}
        {" · "}
        {m.gitGraphHead()}:{" "}
        {context?.head
          ? props.model.derivedGraph?.occurrences.find(
              (commit) => commit.sourceKey === context.head,
            )?.sourceId || m.gitGraphGenerated()
          : "∅"}
      </MyoxusText>
      <Select
        data-autofocus
        label={m.sequenceBranch()}
        value={v.branch}
        disabled={props.readonly}
        data={props.model.branches
          .filter((b) => context?.branchHeads.has(b.id))
          .map((b) => ({
            value: b.sourceKey ?? "",
            label: b.name,
            disabled: b.referenceable === false,
          }))}
        onChange={(b) => d.set("branch", b ?? "")}
      />
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
