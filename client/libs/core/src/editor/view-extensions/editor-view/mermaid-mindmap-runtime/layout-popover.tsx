// SPDX-License-Identifier: AGPL-3.0-or-later
import { useMindmapDraftBasis, handleMindmapSelectKeyDown } from "./drafts";
import { useEffect, useRef, useState } from "react";
import { MindmapAppearanceControls } from "./appearance-controls";
import { useI18n } from "@myoxus/i18n";
import {
  Accordion,
  AccordionItem,
  AccordionControl,
  AccordionPanel,
  Box,
  Checkbox,
  NumberInput,
  Alert,
  Button,
  Group,
  MyoxusText,
  MyoxusSelect,
  RadioGroup,
  Stack,
} from "@myoxus/ui-facade";
import {
  editMindmapNativeConfig,
  readMindmapNativeConfig,
  renderMermaidSvg,
  mermaidMessages as m,
  MindmapDesign,
  MindmapLayoutType,
  mindmapDesignPreview,
  type MindmapReactHostProps,
  type MindmapAction,
} from "@virgultum/block-mermaid";

/** Passive design samples use the same native style getters and theme projection
 * as the tree, without mounting another editable tree or renderer owner. */
export function MindmapDesignPreview({ design }: { design: MindmapDesign }) {
  const sample = mindmapDesignPreview(design);
  return (
    <svg
      width="4em"
      height="3em"
      viewBox="0 0 96 64"
      aria-hidden="true"
      focusable="false"
    >
      {sample.branches.map((branch, index) => (
        <path
          key={index}
          d={
            branch.mode === "orthogonal"
              ? `M28 32 H48 V${12 + index * 20} H66`
              : branch.mode === "curve"
                ? `M28 32 C48 32 48 ${12 + index * 20} 66 ${12 + index * 20}`
                : `M28 32 L66 ${12 + index * 20}`
          }
          fill="none"
          stroke={branch.stroke}
          strokeWidth={branch.strokeWidth}
        />
      ))}
      {[sample.root, ...sample.nodes].map((node, index) => (
        <g key={index}>
          <rect
            x={index ? 66 : 4}
            y={index ? 4 + (index - 1) * 20 : 23}
            width="24"
            height={index ? 16 : 18}
            rx={node.radius ? 3 : 0}
            fill={node.filled ? node.fillColor : "none"}
            stroke={node.strokeColor}
            strokeWidth={node.strokeWidth}
          />
          <path
            d={index ? `M71 ${12 + (index - 1) * 20} h14` : "M9 32 h14"}
            stroke={node.color}
          />
        </g>
      ))}
    </svg>
  );
}

export function MindmapLayoutForm({
  props,
  onClose,
}: {
  props: MindmapReactHostProps;
  onClose: () => void;
}) {
  const t = useI18n();
  const [layout, setLayout] = useState(
    props.projection.layout ?? MindmapLayoutType.RIGHT,
  );
  const [design, setDesign] = useState(
    props.projection.design ?? MindmapDesign.ONE,
  );
  const selected = props.model.nodes.find(
    (node) => node.sourceKey === props.selectedKey,
  );
  const [nodeAppearance, setNodeAppearance] = useState(() =>
    props.selectedKey
      ? (props.projection.nodeAppearance?.get(props.selectedKey) ?? null)
      : null,
  );
  const [branchAppearance, setBranchAppearance] = useState(() =>
    props.selectedKey
      ? (props.projection.branchAppearance?.get(props.selectedKey) ?? null)
      : null,
  );
  const [nativeConfig, setNativeConfig] = useState(
    () => readMindmapNativeConfig(props.model).config,
  );
  const [nativeOpen, setNativeOpen] = useState(false);
  const [nativeSvg, setNativeSvg] = useState<string | null>(null);
  const [nativeError, setNativeError] = useState<string | null>(null);
  const candidate = editMindmapNativeConfig(props.model, nativeConfig);
  const nativeSource =
    candidate.status === "rejected" ? null : candidate.source;
  useEffect(() => {
    if (!nativeOpen || nativeSource === null) return;
    let active = true;
    setNativeSvg(null);
    setNativeError(null);
    renderMermaidSvg(nativeSource, {
      idPrefix: "myoxus-mindmap-native-options",
    })
      .then((result) => {
        if (active) setNativeSvg(result.svg);
      })
      .catch((error: unknown) => {
        if (active)
          setNativeError(
            error instanceof Error ? error.message : m.errorTitle(),
          );
      });
    return () => {
      active = false;
    };
  }, [nativeOpen, nativeSource]);
  const [diagnostic, setDiagnostic] = useState<string | null>(null);
  const basis = useMindmapDraftBasis(props, onClose);
  const preview = useRef<(() => void) | null>(null);
  const dispose = () => {
    preview.current?.();
    preview.current = null;
  };
  useEffect(() => () => preview.current?.(), []);
  const change = (action: MindmapAction) => {
    dispose();
    preview.current = props.onPreview?.(action, basis) ?? null;
  };
  const appearance = {
    ...(selected
      ? { node: { key: selected.sourceKey, appearance: nodeAppearance } }
      : {}),
    ...(selected && !selected.root
      ? { branch: { key: selected.sourceKey, appearance: branchAppearance } }
      : {}),
  };
  const cancel = () => {
    dispose();
    onClose();
  };
  return (
    <Stack
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.stopPropagation();
          cancel();
        }
      }}
    >
      <MyoxusSelect
        onKeyDown={handleMindmapSelectKeyDown}
        label={m.layoutLabel()}
        comboboxProps={{ withinPortal: false }}
        value={String(layout)}
        data={[
          { value: String(MindmapLayoutType.LEFT), label: m.visualMoveLeft() },
          {
            value: String(MindmapLayoutType.RIGHT),
            label: m.visualMoveRight(),
          },
          {
            value: String(MindmapLayoutType.BALANCE),
            label: t["com.myoxus.editor.mermaid.mindmap-layout-balanced"](),
          },
        ]}
        onChange={(value) => {
          const next =
            value === String(MindmapLayoutType.LEFT)
              ? MindmapLayoutType.LEFT
              : value === String(MindmapLayoutType.BALANCE)
                ? MindmapLayoutType.BALANCE
                : MindmapLayoutType.RIGHT;
          setLayout(next);
          change({ type: "settings", layout: next, design, ...appearance });
        }}
      />
      <MyoxusText>{t["com.myoxus.editor.toolbar.style"]()}</MyoxusText>
      <RadioGroup
        value={String(design)}
        items={[
          MindmapDesign.ONE,
          MindmapDesign.TWO,
          MindmapDesign.THREE,
          MindmapDesign.FOUR,
        ].map((value) => ({
          value: String(value),
          label: (
            <Stack>
              <MindmapDesignPreview design={value} />
              <MyoxusText>{value}</MyoxusText>
            </Stack>
          ),
        }))}
        onChange={(value) => {
          const next = [
            MindmapDesign.ONE,
            MindmapDesign.TWO,
            MindmapDesign.THREE,
            MindmapDesign.FOUR,
          ].find((design) => String(design) === value);
          if (next === undefined) return;
          setDesign(next);
          change({ type: "settings", layout, design: next, ...appearance });
        }}
      />
      {selected ? (
        <Accordion>
          <AccordionItem value="node">
            <AccordionControl>
              <Group>
                <MyoxusText>{m.visualAppearance()}</MyoxusText>
                <MyoxusText>{selected.label}</MyoxusText>
              </Group>
            </AccordionControl>
            <AccordionPanel>
              <MindmapAppearanceControls
                value={nodeAppearance}
                onChange={(value) => {
                  setNodeAppearance(value);
                  change({
                    type: "settings",
                    layout,
                    design,
                    ...appearance,
                    node: { key: selected.sourceKey, appearance: value },
                  });
                }}
              />
            </AccordionPanel>
          </AccordionItem>
          {!selected.root ? (
            <AccordionItem value="branch">
              <AccordionControl>{m.sequenceBranch()}</AccordionControl>
              <AccordionPanel>
                <MindmapAppearanceControls
                  branch
                  value={branchAppearance}
                  onChange={(value) => {
                    setBranchAppearance(value);
                    change({
                      type: "settings",
                      layout,
                      design,
                      ...appearance,
                      branch: { key: selected.sourceKey, appearance: value },
                    });
                  }}
                />
              </AccordionPanel>
            </AccordionItem>
          ) : null}
        </Accordion>
      ) : null}
      <Accordion
        value={nativeOpen ? "native" : null}
        onChange={(value) => setNativeOpen(value === "native")}
      >
        <AccordionItem value="native">
          <AccordionControl>
            {t["com.myoxus.editor.mermaid.mindmap-native-options"]()}
          </AccordionControl>
          <AccordionPanel>
            <Stack>
              <MyoxusText>
                {t["com.myoxus.editor.mermaid.mindmap-native-options-help"]()}
              </MyoxusText>
              <NumberInput
                label={m.architecturePadding()}
                value={nativeConfig.padding}
                min={0}
                error={
                  !Number.isFinite(nativeConfig.padding) ||
                  nativeConfig.padding < 0
                }
                onChange={(value) =>
                  setNativeConfig({ ...nativeConfig, padding: Number(value) })
                }
              />
              <NumberInput
                label={t[
                  "com.myoxus.editor.mermaid.mindmap-native-node-width"
                ]()}
                value={nativeConfig.maxNodeWidth}
                min={1}
                error={
                  !Number.isFinite(nativeConfig.maxNodeWidth) ||
                  nativeConfig.maxNodeWidth < 1
                }
                onChange={(value) =>
                  setNativeConfig({
                    ...nativeConfig,
                    maxNodeWidth: Number(value),
                  })
                }
              />
              <Checkbox
                label={m.xyUseMaxWidth()}
                checked={nativeConfig.useMaxWidth}
                onChange={(event) =>
                  setNativeConfig({
                    ...nativeConfig,
                    useMaxWidth: event.currentTarget.checked,
                  })
                }
              />
              {nativeSource === null ? null : nativeError ? (
                <Alert color="myoxusError">
                  {m.errorTitle()}
                  <MyoxusText>{nativeError}</MyoxusText>
                </Alert>
              ) : nativeSvg ? (
                <Box
                  data-myoxus-ui-role="mermaid-mindmap-native-preview"
                  dangerouslySetInnerHTML={{ __html: nativeSvg }}
                />
              ) : null}
            </Stack>
          </AccordionPanel>
        </AccordionItem>
      </Accordion>
      {diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {diagnostic}
        </Alert>
      ) : null}
      <Group>
        <Button
          disabled={nativeSource === null}
          onClick={() => {
            dispose();
            const result = props.onCommand(
              { type: "settings", layout, design, nativeConfig, ...appearance },
              basis,
            );
            if (result.diagnostic) setDiagnostic(result.diagnostic);
            else onClose();
          }}
        >
          {t.Save()}
        </Button>
        <Button variant="secondary" onClick={cancel}>
          {t.Cancel()}
        </Button>
      </Group>
    </Stack>
  );
}
