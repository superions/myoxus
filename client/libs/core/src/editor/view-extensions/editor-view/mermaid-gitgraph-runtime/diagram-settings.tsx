// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Checkbox,
  Accordion,
  AccordionItem,
  AccordionControl,
  AccordionPanel,
  MyoxusText,
  MyoxusTextInput,
  NumberInput,
  Select,
  Stack,
  Textarea,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  readGitGraphConfig,
  readGitGraphGlobalOptions,
  GITGRAPH_GLOBAL_OPTIONS,
  type GitGraphGlobalOption,
  GITGRAPH_DIRECTIONS,
  type GitGraphReactHostProps,
  type GitGraphConfig,
} from "@virgultum/block-mermaid";
import { useGitGraphDraft, gitGraphDraftKey } from "./drafts";
import { GitGraphDraftFooter } from "./commit-popover";
export function GitGraphSettingsForm({
  props,
  onClose,
}: {
  props: GitGraphReactHostProps;
  onClose: () => void;
}) {
  const initial = readGitGraphConfig(props.model.sourceDocument!).config,
    d = useGitGraphDraft(
      { ...initial, direction: props.model.direction },
      props,
    ),
    v = d.value;
  const save = (preview = false) => {
    const changed = Object.fromEntries(
      Object.entries(initial)
        .filter(
          ([key, value]) =>
            JSON.stringify(v[key as keyof GitGraphConfig]) !==
            JSON.stringify(value),
        )
        .map(([key]) => [key, v[key as keyof GitGraphConfig]]),
    );
    const result = d.run(preview, "editGitGraphConfig", [
      changed,
      v.direction === props.model.direction ? undefined : v.direction,
    ]);
    if (!preview && !result.diagnostic) onClose();
  };
  return (
    <Stack onKeyDown={(e) => gitGraphDraftKey(e, () => save(), onClose)}>
      <Select
        label={m.classDirection()}
        value={v.direction}
        data={GITGRAPH_DIRECTIONS.map((value) => ({ value, label: value }))}
        disabled={props.readonly}
        onChange={(direction) =>
          d.set("direction", direction as typeof v.direction)
        }
      />
      <Checkbox
        label={m.gitGraphShowCommitLabel()}
        checked={v.showCommitLabel}
        disabled={props.readonly}
        onChange={(e) => d.set("showCommitLabel", e.target.checked)}
      />
      <Checkbox
        label={m.gitGraphShowBranches()}
        checked={v.showBranches}
        disabled={props.readonly}
        onChange={(e) => d.set("showBranches", e.target.checked)}
      />
      <Checkbox
        label={m.gitGraphRotateCommitLabel()}
        checked={v.rotateCommitLabel}
        disabled={props.readonly}
        onChange={(e) => d.set("rotateCommitLabel", e.target.checked)}
      />
      <Checkbox
        label={m.gitGraphParallelCommits()}
        checked={v.parallelCommits}
        disabled={props.readonly}
        onChange={(e) => d.set("parallelCommits", e.target.checked)}
      />
      <Textarea
        autosize
        label={m.gitGraphMainBranch()}
        value={v.mainBranchName}
        disabled={props.readonly}
        onChange={(e) => d.set("mainBranchName", e)}
      />
      <NumberInput
        label={m.gitGraphOrder()}
        value={Number.isFinite(v.mainBranchOrder) ? v.mainBranchOrder : ""}
        disabled={props.readonly}
        onChange={(n) => d.set("mainBranchOrder", Number(n))}
      />
      <NumberInput
        label={m.gitGraphDiagramPadding()}
        value={v.diagramPadding}
        disabled={props.readonly}
        onChange={(n) => d.set("diagramPadding", Number(n))}
      />
      <NumberInput
        label={m.gitGraphTitleTopMargin()}
        value={Number.isFinite(v.titleTopMargin) ? v.titleTopMargin : ""}
        disabled={props.readonly}
        onChange={(n) => d.set("titleTopMargin", Number(n))}
      />
      <Checkbox
        label={m.gitGraphUseMaxWidth()}
        checked={v.useMaxWidth}
        disabled={props.readonly}
        onChange={(e) => d.set("useMaxWidth", e.target.checked)}
      />
      <Accordion>
        <AccordionItem value="stored">
          <AccordionControl>{m.pieData()}</AccordionControl>
          <AccordionPanel>
            <Stack>
              <MyoxusText>{m.gitGraphStoredOnly()}</MyoxusText>
              {(["width", "height", "x", "y"] as const).map((key) => (
                <NumberInput
                  key={key}
                  label={`nodeLabel.${key}`}
                  value={v.nodeLabel[key]}
                  disabled={props.readonly}
                  onChange={(n) =>
                    d.set("nodeLabel", { ...v.nodeLabel, [key]: Number(n) })
                  }
                />
              ))}
              <Checkbox
                label="arrowMarkerAbsolute"
                checked={v.arrowMarkerAbsolute}
                disabled={props.readonly}
                onChange={(e) => d.set("arrowMarkerAbsolute", e.target.checked)}
              />
            </Stack>
          </AccordionPanel>
        </AccordionItem>
        <AccordionItem value="native">
          <AccordionControl>{m.classNativeRenderer()}</AccordionControl>
          <AccordionPanel>
            <GitGraphNativeOptions props={props} />
          </AccordionPanel>
        </AccordionItem>
      </Accordion>
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
export function GitGraphAccessibilityForm({
  props,
  onClose,
}: {
  props: GitGraphReactHostProps;
  onClose: () => void;
}) {
  const d = useGitGraphDraft(
      {
        title: props.model.accessibilityTitle,
        description: props.model.accessibilityDescription,
      },
      props,
    ),
    v = d.value;
  const save = (preview = false) => {
    const result = d.run(preview, "editGitGraphAccessibility", [
      v.title,
      v.description,
    ]);
    if (!preview && !result.diagnostic) onClose();
  };
  return (
    <Stack onKeyDown={(e) => gitGraphDraftKey(e, () => save(), onClose)}>
      <MyoxusTextInput
        label={m.titlePlaceholder()}
        value={v.title}
        disabled={props.readonly}
        onChange={(e) => d.set("title", e)}
      />
      <Textarea
        label={m.visualAccessibility()}
        value={v.description}
        disabled={props.readonly}
        onChange={(e) => d.set("description", e)}
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

function GitGraphNativeOptions({ props }: { props: GitGraphReactHostProps }) {
  const values = readGitGraphGlobalOptions(props.model.sourceDocument!);
  return (
    <Stack>
      {(Object.keys(GITGRAPH_GLOBAL_OPTIONS) as GitGraphGlobalOption[]).map(
        (name) => (
          <GitGraphNativeOption
            key={name}
            props={props}
            name={name}
            initial={values[name]}
          />
        ),
      )}
    </Stack>
  );
}
function GitGraphNativeOption({
  props,
  name,
  initial,
}: {
  props: GitGraphReactHostProps;
  name: GitGraphGlobalOption;
  initial: unknown;
}) {
  const descriptor = GITGRAPH_GLOBAL_OPTIONS[name],
    d = useGitGraphDraft({ value: initial }, props);
  const save = (preview = false) =>
    d.run(preview, "editGitGraphGlobalOption", [name, d.value.value]);
  return (
    <Stack>
      {descriptor.type === "boolean" ? (
        <Checkbox
          label={name}
          checked={d.value.value === true}
          disabled={props.readonly}
          onChange={(e) => d.set("value", e.target.checked)}
        />
      ) : descriptor.type === "number" ? (
        <NumberInput
          label={name}
          value={typeof d.value.value === "number" ? d.value.value : ""}
          disabled={props.readonly}
          onChange={(v) => d.set("value", v === "" ? undefined : Number(v))}
        />
      ) : descriptor.type === "select" ? (
        <Select
          label={name}
          value={typeof d.value.value === "string" ? d.value.value : null}
          disabled={props.readonly}
          data={descriptor.values.map((value) => ({ value, label: value }))}
          onChange={(v) => d.set("value", v ?? undefined)}
        />
      ) : (
        <MyoxusTextInput
          label={name}
          value={String(d.value.value ?? "")}
          disabled={props.readonly}
          onChange={(v) => d.set("value", v)}
        />
      )}
      {d.value.value !== initial ? (
        <GitGraphDraftFooter
          props={props}
          diagnostic={d.diagnostic}
          impact={d.feedback?.impact}
          preview={() => save(true)}
          apply={() => save()}
          cancel={props.onCloseSelection}
        />
      ) : null}
    </Stack>
  );
}
