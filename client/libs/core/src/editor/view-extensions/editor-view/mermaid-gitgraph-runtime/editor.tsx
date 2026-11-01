// SPDX-License-Identifier: AGPL-3.0-or-later
import { useI18n } from "@myoxus/i18n";
import { useState, useRef } from "react";
import { createPortal } from "react-dom";
import { EditIcon, DeleteIcon, EllipsisIcon } from "@myoxus/icons";
import {
  Box,
  IconButton,
  Button,
  ConfirmModal,
  Group,
  MyoxusText,
  Menu,
  MenuItem,
  Alert,
  Popover,
  PopoverContent,
  PopoverTarget,
  Scrollable,
  Select,
  Stack,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  gitGraphBranchName,
  gitGraphAccessibleName,
  GITGRAPH_ACTIONS,
  gitGraphActionLabel,
  type GitGraphAction,
  type GitGraphReactHostProps,
  gitGraphDeleteKeys,
  gitGraphContextAtAnchor,
} from "@virgultum/block-mermaid";
import { MermaidGfxEditorWorkbench } from "../mermaid-editor-workbench";
import { MermaidEmbeddedActions } from "../mermaid-embedded-actions";
import {
  GitGraphCommitForm,
  GitGraphAnchorFields,
  GitGraphDraftFooter,
  GitGraphTags,
  type GitGraphTagDraft,
} from "./commit-popover";
import { GitGraphBranchForm } from "./branch-popover";
import { GitGraphCheckoutForm } from "./checkout-popover";
import { GitGraphMergeForm } from "./merge-popover";
import { GitGraphCherryPickForm } from "./cherry-pick-popover";
import { GitGraphCommentForm } from "./comment-popover";
import {
  GitGraphSettingsForm,
  GitGraphAccessibilityForm,
} from "./diagram-settings";
import { GitGraphDataForm } from "./data-popover";
import {
  useGitGraphDraft,
  gitGraphDraftKey,
  gitGraphDefaultAnchor,
} from "./drafts";
import { GitGraphReorderHandle } from "./reorder-handle";
import { useGitGraphSelection } from "./selection";
function GitGraphForm({
  props,
  action,
  sourceKey,
  onClose,
}: {
  props: GitGraphReactHostProps;
  action: GitGraphAction;
  sourceKey?: string;
  onClose: () => void;
}) {
  switch (action) {
    case "commit":
      return (
        <GitGraphCommitForm
          props={props}
          sourceKey={sourceKey}
          onClose={onClose}
        />
      );
    case "branch":
      return (
        <GitGraphBranchForm
          props={props}
          sourceKey={sourceKey}
          onClose={onClose}
        />
      );
    case "checkout":
      return (
        <GitGraphCheckoutForm
          props={props}
          sourceKey={sourceKey}
          onClose={onClose}
        />
      );
    case "merge":
      return (
        <GitGraphMergeForm
          props={props}
          sourceKey={sourceKey}
          onClose={onClose}
        />
      );
    case "cherry-pick":
      return (
        <GitGraphCherryPickForm
          props={props}
          sourceKey={sourceKey}
          onClose={onClose}
        />
      );
    case "comments":
      return (
        <GitGraphCommentForm
          props={props}
          sourceKey={sourceKey}
          onClose={onClose}
        />
      );
    case "settings":
      return <GitGraphSettingsForm props={props} onClose={onClose} />;
    case "accessibility":
      return <GitGraphAccessibilityForm props={props} onClose={onClose} />;
    case "data":
      return <GitGraphDataForm props={props} />;
    case "reorder":
      return <GitGraphReorder props={props} onClose={onClose} />;
    case "bulk-tags":
      return <GitGraphBulkTags props={props} onClose={onClose} />;
    case "deleteSelection":
      return null;
  }
}
function GitGraphReorder({
  props,
  onClose,
}: {
  props: GitGraphReactHostProps;
  onClose: () => void;
}) {
  const d = useGitGraphDraft({ anchor: gitGraphDefaultAnchor(props) }, props),
    save = (preview = false) => {
      if (props.selectionProblem) return;
      const result = d.run(preview, "moveGitGraphStatements", [
        props.selectedKeys,
        d.value.anchor,
      ]);
      if (!preview && !result.diagnostic) onClose();
    };
  return (
    <Stack>
      {props.selectionProblem ? <Alert>{props.selectionProblem}</Alert> : null}
      <GitGraphAnchorFields
        props={props}
        value={d.value.anchor}
        onChange={(a) => d.set("anchor", a)}
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
function GitGraphDelete({ props }: { props: GitGraphReactHostProps }) {
  const d = useGitGraphDraft(
      {
        strategy: "only" as "only" | "dependants" | "reassign",
        branch: null as string | null,
        commitKey: null as string | null,
      },
      props,
    ),
    [error, setError] = useState<string | null>(null),
    planned = gitGraphDeleteKeys(
      props.model,
      props.selectedKeys,
      d.value.strategy === "dependants" ? "dependants" : "only",
    );
  return (
    <ConfirmModal
      open
      title={m.visualDelete()}
      confirmText={m.visualDelete()}
      onOpenChange={(open) => {
        if (!open) props.onCloseSelection();
      }}
      onConfirm={() => {
        if (props.selectionProblem) {
          setError(props.selectionProblem);
          return;
        }
        const result = d.run(false, "deleteGitGraphStatements", [
          props.selectedKeys,
          d.value.strategy,
          d.value.strategy === "reassign"
            ? {
                branchKey: d.value.branch ?? undefined,
                commitKey: d.value.commitKey ?? undefined,
              }
            : undefined,
        ]);
        if (result.diagnostic) setError(result.diagnostic);
        else props.onCloseSelection();
      }}
    >
      <Stack>
        <MyoxusText>
          {m.gitGraphImpact()} · {planned.size}
        </MyoxusText>
        {props.model
          .sourceDocument!.records.filter((r) => planned.has(r.sourceKey))
          .map((r) => (
            <MyoxusText key={r.sourceKey}>
              {r.range.line} · {r.kind} ·{" "}
              {r.reference?.value ??
                r.attributes.findLast((a) => a.name === "id")?.value ??
                ""}
            </MyoxusText>
          ))}
        {props.selectionProblem ? (
          <Alert>{props.selectionProblem}</Alert>
        ) : null}
        <Select
          label={m.visualDelete()}
          value={d.value.strategy}
          data={[
            { value: "only", label: m.visualDelete() },
            { value: "dependants", label: m.gitGraphDependants() },
            { value: "reassign", label: m.gitGraphReassign() },
          ]}
          onChange={(value) =>
            d.set("strategy", value as typeof d.value.strategy)
          }
        />
        {d.value.strategy === "reassign" ? (
          <Select
            label={m.sequenceBranch()}
            value={d.value.branch}
            data={props.model.branches
              .filter(
                (branch) =>
                  branch.referenceable !== false &&
                  !planned.has(branch.sourceKey ?? ""),
              )
              .map((branch) => ({
                value: branch.sourceKey ?? "",
                label: branch.name,
              }))}
            onChange={(value) => d.set("branch", value)}
          />
        ) : null}
        {d.value.strategy === "reassign" &&
        props.selectedKeys.some((k) =>
          props.model.derivedGraph?.occurrences.some((c) => c.sourceKey === k),
        ) ? (
          <Select
            label={m.sequenceId()}
            value={d.value.commitKey}
            data={(props.model.derivedGraph?.occurrences ?? [])
              .filter(
                (c) =>
                  c.referenceable && !props.selectedKeys.includes(c.sourceKey),
              )
              .map((c) => ({
                value: c.sourceKey,
                label: `${c.sourceId} · ${gitGraphBranchName(props.model, c.branchId)}`,
              }))}
            onChange={(v) => d.set("commitKey", v)}
          />
        ) : null}
        <GitGraphDraftFooter
          confirmationOnly
          props={props}
          diagnostic={d.diagnostic}
          impact={d.feedback?.impact}
          preview={() =>
            d.run(true, "deleteGitGraphStatements", [
              props.selectedKeys,
              d.value.strategy,
              {
                branchKey: d.value.branch ?? undefined,
                commitKey: d.value.commitKey ?? undefined,
              },
            ])
          }
          apply={() => {
            const result = d.run(false, "deleteGitGraphStatements", [
              props.selectedKeys,
              d.value.strategy,
              {
                branchKey: d.value.branch ?? undefined,
                commitKey: d.value.commitKey ?? undefined,
              },
            ]);
            if (!result.diagnostic) props.onCloseSelection();
          }}
          cancel={props.onCloseSelection}
        />
        {error ? <MyoxusText>{error}</MyoxusText> : null}
      </Stack>
    </ConfirmModal>
  );
}
export function MermaidGitGraphRuntimeEditor({
  props: input,
}: {
  props: GitGraphReactHostProps;
}) {
  const t = useI18n();
  const actionTargets = useRef(new Map<GitGraphAction, HTMLButtonElement>());
  const returnTrigger = useRef<HTMLButtonElement | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const props = useGitGraphSelection(input),
    close = () => {
      const action = props.parentIntent;
      setMoreOpen(false);
      props.onCloseSelection();
      if (action)
        requestAnimationFrame(() => {
          const target = returnTrigger.current?.isConnected
            ? returnTrigger.current
            : actionTargets.current.get(action);
          target?.focus({ preventScroll: true });
        });
    },
    selected = props.selected,
    record = props.model.sourceDocument!.records.find(
      (r) => r.sourceKey === selected?.sourceKey,
    );
  const kind: GitGraphAction =
    selected?.role === "comment"
      ? "comments"
      : selected?.role === "branch" ||
          record?.kind === "branch" ||
          record?.kind === "header"
        ? "branch"
        : record?.kind === "merge"
          ? "merge"
          : record?.kind === "cherry-pick"
            ? "cherry-pick"
            : record?.kind === "checkout"
              ? "checkout"
              : "commit";
  const insertContext = gitGraphContextAtAnchor(
    props.model,
    gitGraphDefaultAnchor(props),
  );
  const primary = GITGRAPH_ACTIONS.filter(
      (a) =>
        !props.readonly &&
        [
          "commit",
          "branch",
          "checkout",
          "merge",
          "cherry-pick",
          "comments",
        ].includes(a),
    ),
    more = GITGRAPH_ACTIONS.filter(
      (a) => !props.readonly && !primary.includes(a) && a !== "deleteSelection",
    ),
    reason = (a: GitGraphAction) =>
      ["merge", "cherry-pick"].includes(a) && !insertContext?.head
        ? m.gitGraphHeadRequired()
        : a === "merge" &&
            ![...(insertContext?.branchHeads ?? [])].some(
              ([name, head]) =>
                name !== insertContext?.branch &&
                head &&
                head !== insertContext?.head,
            )
          ? m.gitGraphBranchRequired()
          : props.readonly &&
              !["comments", "data", "settings", "accessibility"].includes(a)
            ? m.ganttReadOnly()
            : a === "reorder" &&
                (props.selectionProblem || !props.selectedKeys.length)
              ? props.selectionProblem || m.gitGraphMixedSelection()
              : undefined;
  const actionPopover = (action: GitGraphAction) => (
    <Popover
      key={action}
      fitViewport
      trapFocus
      contentMeasure="reading"
      opened={props.parentIntent === action}
      onChange={(open) => {
        if (!open) props.onParentIntent(null);
      }}
    >
      <PopoverTarget>
        <Button
          ref={(element) => {
            if (element) actionTargets.current.set(action, element);
          }}
          disabled={!!reason(action)}
          title={reason(action)}
          onClick={(e) => {
            returnTrigger.current = e.currentTarget;
            props.onParentIntent(props.parentIntent === action ? null : action);
          }}
        >
          {gitGraphActionLabel(action)}
        </Button>
      </PopoverTarget>
      <PopoverContent
        onPointerDown={(e) => e.stopPropagation()}
        aria-label={gitGraphActionLabel(action)}
      >
        <Scrollable.Viewport autosize maxHeight="floating" scrollbars="y">
          {props.parentIntent === action ? (
            <GitGraphForm
              key={`${action}:${props.selected?.sourceKey ?? ""}`}
              props={props}
              action={action}
              onClose={close}
            />
          ) : null}
        </Scrollable.Viewport>
      </PopoverContent>
    </Popover>
  );
  const actions = (
    <Group wrap="nowrap" gap="xs" aria-label={m.controlsLabel()}>
      {primary.map(actionPopover)}
      <Menu
        title={m.visualMoreActions()}
        rootOptions={{
          open:
            moreOpen ||
            !!(props.parentIntent && more.includes(props.parentIntent)),
          onOpenChange: (open) => {
            setMoreOpen(open);
            if (
              !open &&
              props.parentIntent &&
              more.includes(props.parentIntent)
            )
              close();
          },
        }}
        items={
          props.parentIntent && more.includes(props.parentIntent) ? (
            <Scrollable.Viewport autosize maxHeight="popover" scrollbars="y">
              <GitGraphForm
                key={`${props.parentIntent}:${props.selected?.sourceKey ?? ""}`}
                props={props}
                action={props.parentIntent}
                onClose={close}
              />
            </Scrollable.Viewport>
          ) : (
            <>
              <MenuItem
                checked={props.guidesVisible}
                closeMenuOnClick={false}
                onSelect={() =>
                  props.onVisibility("guides", !props.guidesVisible)
                }
              >
                {m.gitGraphGuides()}
              </MenuItem>
              <MenuItem
                checked={props.commentsVisible}
                closeMenuOnClick={false}
                onSelect={() =>
                  props.onVisibility("comments", !props.commentsVisible)
                }
              >
                {m.visualComments()}
              </MenuItem>
              <MenuItem
                disabled={!props.onCopySource}
                onSelect={() => {
                  void props.onCopySource?.().catch(console.error);
                }}
              >
                {t["Copy"]()}
              </MenuItem>
              <MenuItem
                disabled={!props.onExportMmd}
                onSelect={() => props.onExportMmd?.()}
              >
                {m.mmdExport()}
              </MenuItem>
              {more.map((action) => (
                <MenuItem
                  key={action}
                  disabled={!!reason(action)}
                  closeMenuOnClick={false}
                  onSelect={() => {
                    returnTrigger.current =
                      actionTargets.current.get(action) ?? null;
                    props.onParentIntent(action);
                  }}
                >
                  {gitGraphActionLabel(action)}
                </MenuItem>
              ))}
            </>
          )
        }
      >
        <IconButton
          ref={(element) => {
            if (element)
              for (const action of more)
                actionTargets.current.set(action, element);
          }}
          icon={<EllipsisIcon />}
          aria-label={m.visualMoreActions()}
          tooltip={m.visualMoreActions()}
        />
      </Menu>
    </Group>
  );
  const form =
    props.intent && selected ? (
      <GitGraphForm
        props={props}
        action={kind}
        sourceKey={selected.sourceKey}
        onClose={close}
      />
    ) : null;
  // Source commits replace the scoped renderer. Selection can survive before
  // its carrier has an anchor; mounting a detached Popover then feeds Floating's
  // hide/resize cycle. The resolved carrier owns when these controls can mount.
  const selectedControls =
    selected &&
    props.selectedAnchor &&
    (!props.displayOnly || selected.role === "comment") ? (
      <Popover
        opened
        fitViewport
        trapFocus={!!props.intent}
        returnFocus={false}
        contentMeasure={
          form || props.readonly || props.displayOnly ? "reading" : undefined
        }
        floatingStrategy={props.surface === "controls" ? "fixed" : undefined}
        position={props.surface === "controls" ? "right" : "bottom"}
        onChange={(open) => {
          if (!open && props.intent) close();
        }}
      >
        <PopoverTarget>
          <Box
            // Page anchors are workarea-relative; native GFX resolves client
            // coordinates and the body portal keeps Root toolbar transforms out.
            pos={props.surface === "controls" ? "fixed" : "absolute"}
            style={{
              left: props.selectedAnchor?.left,
              top: props.selectedAnchor?.top,
              // A point at the carrier top would place bottom chrome on its mark.
              height: props.selectedAnchor?.height,
            }}
          />
        </PopoverTarget>
        <PopoverContent
          aria-label={
            gitGraphAccessibleName(
              (selected.kind === "edge"
                ? props.visualModel.edges
                : props.visualModel.nodes
              ).find((o) => o.id === selected.visualKey),
            ) || gitGraphActionLabel(kind)
          }
          onPointerDown={(e) => e.stopPropagation()}
        >
          <Scrollable.Viewport autosize maxHeight="floating" scrollbars="y">
            <Stack>
              {!props.readonly && !props.displayOnly ? (
                <Group>
                  <IconButton
                    tooltip={gitGraphActionLabel(kind)}
                    aria-label={gitGraphActionLabel(kind)}
                    onClick={() =>
                      props.onEditIntent({
                        kind: selected.kind,
                        id: selected.visualKey,
                      })
                    }
                  >
                    <EditIcon />
                  </IconButton>
                  <IconButton
                    aria-label={m.visualDelete()}
                    tooltip={
                      selected.role === "relationship"
                        ? m.gitGraphRelationReadOnly()
                        : m.visualDelete()
                    }
                    disabled={
                      selected.role === "relationship" ||
                      record?.kind === "header"
                    }
                    title={
                      selected.role === "relationship"
                        ? m.gitGraphRelationReadOnly()
                        : undefined
                    }
                    onClick={() => props.onParentIntent("deleteSelection")}
                  >
                    <DeleteIcon />
                  </IconButton>
                  {record &&
                  [
                    "commit",
                    "branch",
                    "checkout",
                    "merge",
                    "cherry-pick",
                  ].includes(record.kind) &&
                  selected.role !== "relationship" &&
                  !props.intent ? (
                    <GitGraphReorderHandle
                      props={props}
                      onOpen={(trigger) => {
                        returnTrigger.current = trigger;
                        props.onParentIntent("reorder");
                      }}
                    />
                  ) : null}
                </Group>
              ) : (
                <Stack>
                  <MyoxusText>
                    {gitGraphActionLabel(kind)}
                    {record?.reference?.value
                      ? ` · ${record.reference.value}`
                      : null}
                  </MyoxusText>
                  <MyoxusText>
                    {record?.value ??
                      record?.attributes
                        .map((a) => `${a.name}: ${a.value}`)
                        .join(" · ")}
                  </MyoxusText>
                </Stack>
              )}
              {!props.readonly && !props.displayOnly ? form : null}
            </Stack>
          </Scrollable.Viewport>
        </PopoverContent>
      </Popover>
    ) : null;
  const confirmation =
    props.parentIntent === "deleteSelection" ? (
      <GitGraphDelete props={props} />
    ) : null;
  if (props.surface === "controls")
    return (
      <Group
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        {actions}
        {selectedControls
          ? createPortal(selectedControls, document.body)
          : null}
        {confirmation}
      </Group>
    );
  return (
    <MermaidGfxEditorWorkbench
      isolateEvents={!props.embedded}
      pageViewport={props.embedded ? undefined : props.pageViewport}
      actionTarget={props.displayOnly ? undefined : props.actionTarget}
      context={null}
      contextOpened={false}
      onCloseContext={close}
      onEscape={() => {
        if (!props.intent && !props.parentIntent) return false;
        close();
        return true;
      }}
      onEmbeddedActionsInsetChange={props.onEmbeddedActionsInsetChange}
      embeddedActions={
        props.embedded && props.embeddedEditing && !props.displayOnly ? (
          <MermaidEmbeddedActions actions={actions} label={m.controlsLabel()} />
        ) : null
      }
      onWorkareaResize={props.onWorkareaResize}
      resolveReturnFocusTarget={props.resolveReturnFocusTarget}
      selectionKey={selected?.sourceKey ?? ""}
      selectionControls={
        <>
          {selectedControls}
          {confirmation}
        </>
      }
      toolbar={props.embedded || props.displayOnly ? null : actions}
      workarea={props.workarea}
      workareaFooter={props.workareaFooter}
      workareaLabel={m.controlsLabel()}
      workareaAccessibilityTitle={
        props.model.accessibilityTitle || m.controlsLabel()
      }
      workareaAccessibilityDescription={props.model.accessibilityDescription}
    />
  );
}

function GitGraphBulkTags({
  props,
  onClose,
}: {
  props: GitGraphReactHostProps;
  onClose: () => void;
}) {
  const d = useGitGraphDraft(
      { tags: [] as GitGraphTagDraft[], mode: "add" as "add" | "replace" },
      props,
    ),
    save = (preview = false) => {
      if (props.selectionProblem) return;
      const result = d.run(preview, "editGitGraphBulkTags", [
        props.selectedKeys,
        d.value.tags.map((t) => t.value),
        d.value.mode,
      ]);
      if (!preview && !result.diagnostic) onClose();
    };
  return (
    <Stack onKeyDown={(e) => gitGraphDraftKey(e, () => save(), onClose)}>
      <MyoxusText>
        {props.selectedKeys.length} · {m.selectedCommitTag()}
      </MyoxusText>
      <Select
        value={d.value.mode}
        data={[
          { value: "add", label: m.architectureAdd() },
          { value: "replace", label: m.visualReplace() },
        ]}
        onChange={(v) => d.set("mode", v === "replace" ? "replace" : "add")}
      />
      <GitGraphTags
        value={d.value.tags}
        onChange={(v) => d.set("tags", v)}
        readonly={props.readonly}
      />
      {props.selectionProblem ? <Alert>{props.selectionProblem}</Alert> : null}
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
