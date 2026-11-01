// SPDX-License-Identifier: AGPL-3.0-or-later

import { useI18n } from "@myoxus/i18n";
import {
  AlertTriangleIcon,
  ArrowShapeIcon,
  CircleIcon,
  CloudBubbleIcon,
  CodeBlockIcon,
  CrossedCircleIcon,
  CylinderIcon,
  DiamondIcon,
  DownloadIcon,
  EditIcon,
  FileIcon,
  FilesIcon,
  Flag2PanelIcon,
  FlashPanelIcon,
  GitBranchIcon,
  GroupIcon,
  HexagonIcon,
  LeftBracketIcon,
  LinkIcon,
  MoreHorizontalIcon,
  PaletteIcon,
  ParallelogramIcon,
  PlusIcon,
  RightBracketIcon,
  RoundedSquareIcon,
  ShapeIcon,
  ShapesIcon,
  SquareIcon,
  TagIcon,
  TextIcon,
  TimerIcon,
  TriangleIcon,
  WindowPanelIcon,
} from "@myoxus/icons";
import {
  Alert,
  Box,
  Button,
  CanvasOverlayToolbar,
  ColorSwatch,
  IconButton,
  IconButtonGroup,
  Menu,
  MenuItem,
  MenuScrollableSection,
  MenuSub,
  MyoxusText,
  MyoxusTextInput,
  Popover,
  PopoverContent,
  PopoverTarget,
  Stack,
  Group,
  SplitMenuButton,
  Switch,
  ToolbarSurface,
} from "@myoxus/ui-facade";
import type {
  MermaidFlowchartReactHostProps,
  MermaidFlowchartMetadataReactHostProps,
  MermaidFlowchartReactRendererProps,
  MermaidSemanticStyleOption,
  MermaidVisualEdgeLinkType,
  MermaidVisualEdgeStyle,
  MermaidVisualNodeShape,
  MermaidVisualSemanticStyle,
} from "@virgultum/block-mermaid";
import { type ReactNode, useEffect, useState } from "react";
import {
  MermaidGfxEditorWorkbench,
  MermaidPageSelectionToolControls,
  MermaidSelectionDeleteAction,
} from "../mermaid-editor-workbench";
import { MermaidEmbeddedActions } from "../mermaid-embedded-actions";
import type { ReactToLit } from "@myoxus/lit-react";
import {
  mermaidFlowchartRendererToken,
  type MermaidFamilyReactRendererRegistration,
} from "@virgultum/block-mermaid";
import { MermaidFlowchartAccessibility } from "./accessibility";
import { MermaidFlowchartComments } from "./comments";
import { FlowchartTextFormatting } from "./text-formatting";

function MermaidFlowchartMetadataAction({
  props,
}: {
  readonly props: MermaidFlowchartMetadataReactHostProps;
}) {
  return props.kind === "comments" ? (
    <MermaidFlowchartComments comments={props.comments} marker props={props} />
  ) : (
    <MermaidFlowchartAccessibility props={props} />
  );
}

function selectedComments(props: MermaidFlowchartReactHostProps) {
  const anchorId = props.selectionKey.replace(/^(?:node|edge|subgraph):/, "");
  return anchorId
    ? props.comments.filter((comment) => comment.anchorId === anchorId)
    : [];
}

function MermaidFlowchartAnchoredComments({
  anchor,
  props,
}: {
  readonly anchor: { readonly left: number; readonly top: number };
  readonly props: MermaidFlowchartReactHostProps;
}) {
  const comments = selectedComments(props);
  if (!comments.length) return null;
  return (
    <Box
      data-myoxus-ui-role="mermaid-flowchart-comment-marker"
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      pos="absolute"
      style={{
        left: anchor.left,
        top: anchor.top,
        transform: "translate(-50%, calc(-100% - var(--mantine-spacing-xs)))",
        zIndex: 25,
      }}
    >
      <MermaidFlowchartComments comments={comments} marker props={props} />
    </Box>
  );
}

function shapeIcon(shape: MermaidVisualNodeShape) {
  if (shape === "rect") return <SquareIcon />;
  if (shape === "rounded") return <RoundedSquareIcon />;
  if (shape === "diamond" || shape === "diam") return <DiamondIcon />;
  if (shape === "circle" || shape === "f-circ" || shape === "sm-circ") {
    return <CircleIcon />;
  }
  if (shape === "cross-circ") return <CrossedCircleIcon />;
  if (
    shape === "database" ||
    shape === "datastore" ||
    shape === "h-cyl" ||
    shape === "lin-cyl"
  ) {
    return <CylinderIcon />;
  }
  if (shape === "subroutine" || shape === "div-rect") {
    return <CodeBlockIcon />;
  }
  if (shape === "hexagon" || shape === "notch-pent") return <HexagonIcon />;
  if (shape === "parallelogram") return <ParallelogramIcon />;
  if (
    shape === "asymmetric" ||
    shape === "lean-l" ||
    shape === "lean-r" ||
    shape === "trap-b" ||
    shape === "trap-t" ||
    shape === "trapezoid"
  ) {
    return <ArrowShapeIcon />;
  }
  if (shape === "doc" || shape === "lin-doc" || shape === "tag-doc") {
    return <FileIcon />;
  }
  if (shape === "docs") return <FilesIcon />;
  if (shape === "cloud") return <CloudBubbleIcon />;
  if (shape === "bolt") return <FlashPanelIcon />;
  if (shape === "flag") return <Flag2PanelIcon />;
  if (shape === "fork") return <GitBranchIcon />;
  if (shape === "bang") return <AlertTriangleIcon />;
  if (shape === "brace") return <LeftBracketIcon />;
  if (shape === "brace-r" || shape === "braces") return <RightBracketIcon />;
  if (shape === "tag-rect") return <TagIcon />;
  if (shape === "text") return <TextIcon />;
  if (shape === "delay" || shape === "hourglass") return <TimerIcon />;
  if (shape === "tri" || shape === "flip-tri") return <TriangleIcon />;
  if (shape === "win-pane") return <WindowPanelIcon />;
  return <ShapeIcon />;
}

function semanticStyleSwatch(
  option: MermaidSemanticStyleOption,
  target: "edge" | "node",
) {
  return target === "node" ? (
    <ColorSwatch
      color={option.preview.backgroundColor}
      data-myoxus-ui-role="mermaid-node-style-swatch"
      foregroundColor={option.preview.foregroundColor}
      outlineColor={option.preview.outlineColor}
      previewText="Aa"
      size="var(--mantine-spacing-lg)"
    />
  ) : (
    <ColorSwatch
      color={option.preview.edgeColor}
      data-myoxus-ui-role="mermaid-edge-style-swatch"
      shape="circle"
      size="var(--mantine-spacing-md)"
    />
  );
}

function MermaidFlowchartObjectActionSurface({
  anchor,
  children,
  label,
  role,
}: {
  readonly anchor: { readonly left: number; readonly top: number };
  readonly children: ReactNode;
  readonly label: string;
  readonly role: string;
}) {
  return (
    <Box
      data-myoxus-ui-role={role}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      pos="absolute"
      style={{
        left: anchor.left,
        top: anchor.top,
        transform: "translate(-50%, calc(-100% - var(--mantine-spacing-xs)))",
        zIndex: "var(--myoxus-z-index-popover)",
      }}
    >
      <CanvasOverlayToolbar>
        <ToolbarSurface compact>
          <IconButtonGroup aria-label={label}>{children}</IconButtonGroup>
        </ToolbarSurface>
      </CanvasOverlayToolbar>
    </Box>
  );
}

function MermaidFlowchartNodeActions({
  pageMore = false,
  props,
}: {
  readonly pageMore?: boolean;
  readonly props: MermaidFlowchartReactHostProps;
}) {
  const t = useI18n();
  const [invalidLink, setInvalidLink] = useState(false);
  const [linkDraft, setLinkDraft] = useState(props.nodeLink);
  const [linkOpened, setLinkOpened] = useState(false);

  useEffect(() => {
    setInvalidLink(false);
    setLinkDraft(props.nodeLink);
    setLinkOpened(false);
  }, [props.nodeLink, props.selectionKey]);

  if (props.nodeShape === null) return null;
  if (props.displayOnly) {
    if (props.nodeActionAnchor === null) return null;
    return (
      <MermaidFlowchartAnchoredComments
        anchor={props.nodeActionAnchor}
        props={props}
      />
    );
  }

  const shapeLabel = t["com.myoxus.editor.toolbar.shape"]();
  const styleLabel = t["com.myoxus.editor.toolbar.style"]();
  const linkLabel = t["com.myoxus.editor.keyboard.link"]();
  const pageMarkdownLabel = t["com.myoxus.shortcutsTitle.markdownSyntax"]();
  const groupLabel = t["com.myoxus.keyboardShortcuts.group"]();
  const linkEditor = (
    <Stack gap="xs">
      <MyoxusTextInput
        aria-label={linkLabel}
        onChange={(value) => {
          setInvalidLink(false);
          setLinkDraft(value);
        }}
        value={linkDraft}
      />
      {invalidLink ? (
        <Alert color="myoxusError" role="alert" variant="light">
          {t["com.myoxus.editor.embed.valid-url-hint"]()}
        </Alert>
      ) : null}
      <Button
        onClick={() => {
          const applied = props.onNodeLinkChange(linkDraft);
          setInvalidLink(!applied);
          if (applied) setLinkOpened(false);
        }}
        variant="primary"
      >
        {t["Save"]()}
      </Button>
    </Stack>
  );

  if (pageMore) {
    return (
      <Group gap="xs" wrap="nowrap">
        <IconButton
          aria-label={t["Edit"]()}
          disabled={props.readonly}
          icon={<EditIcon />}
          onClick={props.onEditNodeLabel}
          tooltip={t["Edit"]()}
        />
        <IconButton
          aria-label={pageMarkdownLabel}
          aria-pressed={props.nodeMarkdown}
          disabled={props.readonly}
          icon={<CodeBlockIcon />}
          onClick={() => props.onNodeMarkdownChange(!props.nodeMarkdown)}
          tooltip={pageMarkdownLabel}
        />
        {props.nodeSubgraphOptions.length ? (
          <Menu
            items={props.nodeSubgraphOptions.map((option) => (
              <MenuItem
                key={option.id}
                onSelect={() => props.onNodeSubgraphChange(option.id)}
                selected={option.selected}
              >
                {option.label ||
                  t["com.myoxus.page.display.grouping.no-grouping"]()}
              </MenuItem>
            ))}
            title={groupLabel}
          >
            <IconButton
              aria-label={groupLabel}
              disabled={props.readonly}
              icon={<Flag2PanelIcon />}
              tooltip={groupLabel}
            />
          </Menu>
        ) : null}
        <MenuSub
          items={linkEditor}
          subContentOptions={{
            panelPadding: "comfortable",
            panelWidth: "comfortable",
          }}
          subOptions={{ open: linkOpened, onOpenChange: setLinkOpened }}
          triggerOptions={{
            disabled: props.readonly,
            prefixIcon: <LinkIcon />,
          }}
        >
          {linkLabel}
        </MenuSub>
      </Group>
    );
  }

  if (props.nodeActionAnchor === null) return null;
  return (
    <MermaidFlowchartObjectActionSurface
      anchor={props.nodeActionAnchor}
      label={props.labels.toolbar}
      role="mermaid-flowchart-node-actions"
    >
      <IconButton
        aria-label={t["Edit"]()}
        disabled={props.readonly}
        icon={<EditIcon />}
        onClick={props.onEditNodeLabel}
        tooltip={t["Edit"]()}
      />
      {props.typography ? (
        <FlowchartTextFormatting props={props.typography} />
      ) : null}
      <Menu
        items={
          <MenuScrollableSection maxHeight="default">
            {props.shapeOptions.map((option) => (
              <MenuItem
                aria-label={option.actionLabel}
                key={option.value}
                onSelect={() => props.onNodeShapeChange(option.value)}
                prefixIcon={shapeIcon(option.value)}
                selected={props.nodeShape === option.value}
              >
                {option.label}
              </MenuItem>
            ))}
          </MenuScrollableSection>
        }
        title={shapeLabel}
      >
        <IconButton
          aria-label={shapeLabel}
          disabled={props.readonly}
          icon={<ShapesIcon />}
          tooltip={shapeLabel}
        />
      </Menu>
      <MermaidFlowchartPageAction props={{ ...props, projection: "connect" }} />
      <MermaidFlowchartComments
        comments={selectedComments(props)}
        marker
        props={props}
      />
      <Menu
        items={
          <>
            <MenuSub
              items={props.labels.semanticStyleOptions.map((option) => (
                <MenuItem
                  key={option.value || "default"}
                  onSelect={() =>
                    props.onNodeStyleChange(
                      option.value === ""
                        ? null
                        : (option.value as MermaidVisualSemanticStyle),
                    )
                  }
                  prefix={semanticStyleSwatch(option, "node")}
                  selected={(props.nodeStyle ?? "") === option.value}
                >
                  {option.label}
                </MenuItem>
              ))}
              triggerOptions={{
                disabled: props.readonly,
                prefixIcon: <PaletteIcon />,
              }}
            >
              {styleLabel}
            </MenuSub>
            <MenuSub
              items={linkEditor}
              subContentOptions={{
                panelPadding: "comfortable",
                panelWidth: "comfortable",
              }}
              subOptions={{ open: linkOpened, onOpenChange: setLinkOpened }}
              triggerOptions={{
                disabled: props.readonly,
                prefixIcon: <LinkIcon />,
              }}
            >
              {linkLabel}
            </MenuSub>
            <Box p="xs">
              <Switch
                aria-label={props.labels.nodeMarkdown}
                checked={props.nodeMarkdown}
                disabled={props.readonly}
                onChange={props.onNodeMarkdownChange}
              >
                {props.labels.nodeMarkdown}
              </Switch>
            </Box>
            {props.nodeSubgraphOptions.length ? (
              <MenuSub
                items={props.nodeSubgraphOptions.map((option) => (
                  <MenuItem
                    key={option.id}
                    onSelect={() => props.onNodeSubgraphChange(option.id)}
                    selected={option.selected}
                  >
                    {option.label ||
                      t["com.myoxus.page.display.grouping.no-grouping"]()}
                  </MenuItem>
                ))}
                triggerOptions={{
                  disabled: props.readonly,
                  prefixIcon: <GroupIcon />,
                }}
              >
                {groupLabel}
              </MenuSub>
            ) : null}
          </>
        }
        title={props.labels.moreActions}
      >
        <IconButton
          aria-label={props.labels.moreActions}
          disabled={props.readonly}
          icon={<MoreHorizontalIcon />}
          tooltip={props.labels.moreActions}
        />
      </Menu>
      <MermaidSelectionDeleteAction
        action={props.selectionAction}
        resolveReturnFocusTarget={props.resolveReturnFocusTarget}
      />
    </MermaidFlowchartObjectActionSurface>
  );
}

function MermaidFlowchartEdgeActions({
  pageMore = false,
  props,
}: {
  readonly pageMore?: boolean;
  readonly props: MermaidFlowchartReactHostProps;
}) {
  const t = useI18n();
  const [labelDraft, setLabelDraft] = useState(props.edgeLabel ?? "");
  const [labelOpened, setLabelOpened] = useState(false);

  useEffect(() => {
    setLabelDraft(props.edgeLabel ?? "");
    setLabelOpened(false);
  }, [props.edgeLabel, props.selectionKey]);

  if (props.edgeStyle === null) return null;
  if (props.displayOnly) {
    if (props.edgeActionAnchor === null) return null;
    return (
      <MermaidFlowchartAnchoredComments
        anchor={props.edgeActionAnchor}
        props={props}
      />
    );
  }
  if (pageMore) {
    return (
      <Group gap="xs" wrap="nowrap">
        <Popover opened={labelOpened} onChange={setLabelOpened}>
          <PopoverTarget>
            <IconButton
              aria-expanded={labelOpened}
              aria-label={props.labels.edgeLabel}
              disabled={props.readonly}
              icon={<EditIcon />}
              onClick={() => setLabelOpened((opened) => !opened)}
              tooltip={props.labels.edgeLabel}
            />
          </PopoverTarget>
          <PopoverContent>
            <Stack gap="xs">
              <MyoxusTextInput
                aria-label={props.labels.edgeLabel}
                onChange={setLabelDraft}
                value={labelDraft}
              />
              <Button
                onClick={() => {
                  props.onEdgeLabelChange(labelDraft);
                  setLabelOpened(false);
                }}
                variant="primary"
              >
                {t["Save"]()}
              </Button>
            </Stack>
          </PopoverContent>
        </Popover>
        <Menu
          items={props.labels.edgeStyleOptions.map((option) => (
            <MenuItem
              key={option.value}
              onSelect={() =>
                props.onEdgeStyleChange(option.value as MermaidVisualEdgeStyle)
              }
              selected={props.edgeStyle === option.value}
            >
              {option.label}
            </MenuItem>
          ))}
          title={props.labels.edgeStyle}
        >
          <IconButton
            aria-label={props.labels.edgeStyle}
            disabled={props.readonly}
            icon={<ShapeIcon />}
            tooltip={props.labels.edgeStyle}
          />
        </Menu>
        <Menu
          items={props.labels.edgeLinkTypeOptions.map((option) => (
            <MenuItem
              key={option.value}
              onSelect={() =>
                props.onEdgeLinkTypeChange(
                  option.value as MermaidVisualEdgeLinkType,
                )
              }
              selected={props.edgeLinkType === option.value}
            >
              {option.label}
            </MenuItem>
          ))}
          title={props.labels.edgeLinkType}
        >
          <IconButton
            aria-label={props.labels.edgeLinkType}
            disabled={props.readonly}
            icon={<LinkIcon />}
            tooltip={props.labels.edgeLinkType}
          />
        </Menu>
      </Group>
    );
  }
  if (props.edgeActionAnchor === null) return null;

  return (
    <MermaidFlowchartObjectActionSurface
      anchor={props.edgeActionAnchor}
      label={props.labels.toolbar}
      role="mermaid-flowchart-edge-actions"
    >
      {props.typography ? (
        <FlowchartTextFormatting props={props.typography} />
      ) : null}
      <Popover opened={labelOpened} onChange={setLabelOpened}>
        <PopoverTarget>
          <IconButton
            aria-expanded={labelOpened}
            aria-label={props.labels.edgeLabel}
            disabled={props.readonly}
            icon={<EditIcon />}
            onClick={() => setLabelOpened((opened) => !opened)}
            tooltip={props.labels.edgeLabel}
          />
        </PopoverTarget>
        <PopoverContent>
          <Stack gap="xs">
            <MyoxusTextInput
              aria-label={props.labels.edgeLabel}
              onChange={setLabelDraft}
              value={labelDraft}
            />
            <Button
              onClick={() => {
                props.onEdgeLabelChange(labelDraft);
                setLabelOpened(false);
              }}
              variant="primary"
            >
              {t["Save"]()}
            </Button>
          </Stack>
        </PopoverContent>
      </Popover>
      <Menu
        items={props.labels.edgeStyleOptions.map((option) => (
          <MenuItem
            key={option.value}
            onSelect={() =>
              props.onEdgeStyleChange(option.value as MermaidVisualEdgeStyle)
            }
            selected={props.edgeStyle === option.value}
          >
            {option.label}
          </MenuItem>
        ))}
        title={props.labels.edgeStyle}
      >
        <IconButton
          aria-label={props.labels.edgeStyle}
          disabled={props.readonly}
          icon={<ShapeIcon />}
          tooltip={props.labels.edgeStyle}
        />
      </Menu>
      <Menu
        items={props.labels.edgeLinkTypeOptions.map((option) => (
          <MenuItem
            key={option.value}
            onSelect={() =>
              props.onEdgeLinkTypeChange(
                option.value as MermaidVisualEdgeLinkType,
              )
            }
            selected={props.edgeLinkType === option.value}
          >
            {option.label}
          </MenuItem>
        ))}
        title={props.labels.edgeLinkType}
      >
        <IconButton
          aria-label={props.labels.edgeLinkType}
          disabled={props.readonly}
          icon={<LinkIcon />}
          tooltip={props.labels.edgeLinkType}
        />
      </Menu>
      <MermaidFlowchartComments
        comments={selectedComments(props)}
        marker
        props={props}
      />
      <Menu
        items={
          <MenuSub
            items={props.labels.semanticStyleOptions.map((option) => (
              <MenuItem
                key={option.value || "default"}
                onSelect={() =>
                  props.onEdgeVisualStyleChange(
                    option.value === ""
                      ? null
                      : (option.value as MermaidVisualSemanticStyle),
                  )
                }
                prefix={semanticStyleSwatch(option, "edge")}
                selected={(props.edgeVisualStyle ?? "") === option.value}
              >
                {option.label}
              </MenuItem>
            ))}
            triggerOptions={{
              disabled: props.readonly,
              prefixIcon: <PaletteIcon />,
            }}
          >
            {props.labels.edgeVisualStyle}
          </MenuSub>
        }
        title={props.labels.moreActions}
      >
        <IconButton
          aria-label={props.labels.moreActions}
          disabled={props.readonly}
          icon={<MoreHorizontalIcon />}
          tooltip={props.labels.moreActions}
        />
      </Menu>
      <MermaidSelectionDeleteAction
        action={props.selectionAction}
        resolveReturnFocusTarget={props.resolveReturnFocusTarget}
      />
    </MermaidFlowchartObjectActionSurface>
  );
}

function MermaidFlowchartSubgraphActions({
  pageMore = false,
  props,
}: {
  readonly pageMore?: boolean;
  readonly props: MermaidFlowchartReactHostProps;
}) {
  const t = useI18n();
  if (props.subgraphTitle === null) return null;
  if (props.displayOnly) {
    if (props.subgraphActionAnchor === null) return null;
    return (
      <MermaidFlowchartAnchoredComments
        anchor={props.subgraphActionAnchor}
        props={props}
      />
    );
  }
  const directions = ["TD", "TB", "BT", "LR", "RL"] as const;
  const directionLabel = t["com.myoxus.documentGraph.direction.label"]();
  const groupLabel = t["com.myoxus.keyboardShortcuts.group"]();
  const noGroupingLabel = t["com.myoxus.page.display.grouping.no-grouping"]();
  if (pageMore) {
    return (
      <Group gap="xs" wrap="nowrap">
        <IconButton
          aria-label={props.labels.subgraphTitle}
          disabled={props.readonly}
          icon={<EditIcon />}
          onClick={props.onEditSubgraphTitle}
          tooltip={props.labels.subgraphTitle}
        />
        <Menu
          items={directions.map((direction) => (
            <MenuItem
              key={direction}
              onSelect={() => props.onSubgraphDirectionChange(direction)}
              selected={props.subgraphDirection === direction}
            >
              {direction}
            </MenuItem>
          ))}
          title={directionLabel}
        >
          <IconButton
            aria-label={directionLabel}
            disabled={props.readonly}
            icon={<GitBranchIcon />}
            tooltip={directionLabel}
          />
        </Menu>
        <Menu
          items={props.subgraphParentOptions.map((option) => (
            <MenuItem
              key={option.id || "root"}
              onSelect={() => props.onSubgraphParentChange(option.id)}
              selected={option.selected}
            >
              {option.label || noGroupingLabel}
            </MenuItem>
          ))}
          title={groupLabel}
        >
          <IconButton
            aria-label={groupLabel}
            disabled={props.readonly}
            icon={<Flag2PanelIcon />}
            tooltip={groupLabel}
          />
        </Menu>
        <Menu
          items={
            <>
              <MenuItem
                disabled={props.readonly || !props.canMoveSubgraphUp}
                onSelect={() => props.onSubgraphReorder(-1)}
              >
                {props.labels.moveUp}
              </MenuItem>
              <MenuItem
                disabled={props.readonly || !props.canMoveSubgraphDown}
                onSelect={() => props.onSubgraphReorder(1)}
              >
                {props.labels.moveDown}
              </MenuItem>
            </>
          }
          title={props.labels.moreActions}
        >
          <IconButton
            aria-label={props.labels.moreActions}
            disabled={props.readonly}
            icon={<MoreHorizontalIcon />}
            tooltip={props.labels.moreActions}
          />
        </Menu>
      </Group>
    );
  }
  if (props.subgraphActionAnchor === null) return null;
  return (
    <MermaidFlowchartObjectActionSurface
      anchor={props.subgraphActionAnchor}
      label={props.labels.toolbar}
      role="mermaid-flowchart-subgraph-actions"
    >
      {props.typography ? (
        <FlowchartTextFormatting props={props.typography} />
      ) : null}
      <IconButton
        aria-label={props.labels.subgraphTitle}
        disabled={props.readonly}
        icon={<EditIcon />}
        onClick={props.onEditSubgraphTitle}
        tooltip={props.labels.subgraphTitle}
      />
      <Menu
        items={directions.map((direction) => (
          <MenuItem
            key={direction}
            onSelect={() => props.onSubgraphDirectionChange(direction)}
            selected={props.subgraphDirection === direction}
          >
            {direction}
          </MenuItem>
        ))}
        title={directionLabel}
      >
        <IconButton
          aria-label={directionLabel}
          disabled={props.readonly}
          icon={<GitBranchIcon />}
          tooltip={directionLabel}
        />
      </Menu>
      <Menu
        items={props.subgraphParentOptions.map((option) => (
          <MenuItem
            key={option.id || "root"}
            onSelect={() => props.onSubgraphParentChange(option.id)}
            selected={option.selected}
          >
            {option.label || noGroupingLabel}
          </MenuItem>
        ))}
        title={groupLabel}
      >
        <IconButton
          aria-label={groupLabel}
          disabled={props.readonly}
          icon={<GroupIcon />}
          tooltip={groupLabel}
        />
      </Menu>
      <MermaidFlowchartComments
        comments={selectedComments(props)}
        marker
        props={props}
      />
      <Menu
        items={
          <>
            <MenuItem
              disabled={props.readonly || !props.canMoveSubgraphUp}
              onSelect={() => props.onSubgraphReorder(-1)}
            >
              {props.labels.moveUp}
            </MenuItem>
            <MenuItem
              disabled={props.readonly || !props.canMoveSubgraphDown}
              onSelect={() => props.onSubgraphReorder(1)}
            >
              {props.labels.moveDown}
            </MenuItem>
          </>
        }
        title={props.labels.moreActions}
      >
        <IconButton
          aria-label={props.labels.moreActions}
          disabled={props.readonly}
          icon={<MoreHorizontalIcon />}
          tooltip={props.labels.moreActions}
        />
      </Menu>
      <MermaidSelectionDeleteAction
        action={props.selectionAction}
        resolveReturnFocusTarget={props.resolveReturnFocusTarget}
      />
    </MermaidFlowchartObjectActionSurface>
  );
}

function MermaidFlowchartPageAction({
  props,
}: {
  readonly props: MermaidFlowchartReactHostProps;
}) {
  const t = useI18n();
  const diagramComments = props.comments.filter(
    (comment) => comment.anchorKind === "diagram",
  );
  const actionComments = props.selectionKey
    ? selectedComments(props)
    : diagramComments;

  if (props.projection === "add-node") {
    return (
      <IconButton
        aria-label={props.labels.addNode}
        disabled={props.readonly}
        icon={<PlusIcon />}
        onClick={props.onAddNode}
        tooltip={props.labels.addNode}
      />
    );
  }
  if (props.projection === "add-subgraph") {
    return (
      <IconButton
        aria-label={props.labels.addSubgraph}
        disabled={props.readonly || !props.canAddSubgraph}
        icon={<GroupIcon />}
        onClick={props.onAddSubgraph}
        tooltip={props.addSubgraphDisabledReason || props.labels.addSubgraph}
      />
    );
  }
  if (props.projection === "connect") {
    const label = props.connecting
      ? `${props.labels.connecting}. ${props.labels.connectingHint}`
      : props.labels.connect;
    return (
      <IconButton
        aria-label={label}
        aria-pressed={props.connecting}
        data-myoxus-ui-role={
          props.connecting ? "mermaid-flowchart-connection-feedback" : undefined
        }
        disabled={props.readonly || (!props.canConnect && !props.connecting)}
        icon={<LinkIcon />}
        onClick={props.onConnect}
        tooltip={props.connectDisabledReason || label}
      />
    );
  }
  if (props.projection === "shapes") {
    return (
      <Menu
        items={
          <MenuScrollableSection maxHeight="default">
            {props.shapeOptions.map((option) => (
              <MenuItem
                aria-label={option.actionLabel}
                key={option.value}
                onSelect={() => props.onNodeShapeChange(option.value)}
                prefixIcon={shapeIcon(option.value)}
                selected={props.nodeShape === option.value}
              >
                {option.label}
              </MenuItem>
            ))}
          </MenuScrollableSection>
        }
        title={props.labels.shapeMenu}
      >
        <IconButton
          aria-label={props.labels.shapeMenu}
          disabled={
            props.readonly || Boolean(props.singleObjectActionsDisabledReason)
          }
          icon={<ShapesIcon />}
          tooltip={
            props.singleObjectActionsDisabledReason || props.labels.shapeMenu
          }
        />
      </Menu>
    );
  }
  if (props.projection === "comments") {
    return (
      <MermaidFlowchartComments
        comments={actionComments}
        marker
        props={props}
      />
    );
  }
  if (props.projection === "appearance") {
    const nodeSelected = props.nodeShape !== null;
    const edgeSelected = props.edgeStyle !== null;
    const current = nodeSelected
      ? (props.nodeStyle ?? "")
      : (props.edgeVisualStyle ?? "");
    const label = nodeSelected
      ? props.labels.nodeStyle
      : props.labels.edgeVisualStyle;
    return (
      <>
        {props.typography ? (
          <FlowchartTextFormatting props={props.typography} />
        ) : null}
        <Menu
          items={props.labels.semanticStyleOptions.map((option) => (
            <MenuItem
              key={option.value || "default"}
              onSelect={() => {
                const value =
                  option.value === ""
                    ? null
                    : (option.value as MermaidVisualSemanticStyle);
                if (nodeSelected) props.onNodeStyleChange(value);
                else if (edgeSelected) props.onEdgeVisualStyleChange(value);
              }}
              prefix={semanticStyleSwatch(
                option,
                nodeSelected ? "node" : "edge",
              )}
              selected={current === option.value}
            >
              {option.label}
            </MenuItem>
          ))}
          title={label}
        >
          <IconButton
            aria-label={label}
            disabled={
              props.readonly ||
              Boolean(props.singleObjectActionsDisabledReason) ||
              (!nodeSelected && !edgeSelected)
            }
            icon={<PaletteIcon />}
            tooltip={props.singleObjectActionsDisabledReason || label}
          />
        </Menu>
      </>
    );
  }
  if (props.projection === "more") {
    const embeddedDiagramActions = (
      <Stack gap="xs">
        <MermaidFlowchartComments
          applyLabel={t["com.myoxus.m.selector.confirm-default"]()}
          comments={diagramComments}
          onAddComment={props.onAddDiagramComment}
          props={props}
          showCancel
        />
        <MermaidFlowchartAccessibility props={props} />
        {props.canApplyLayout ? (
          <Button
            disabled={props.readonly}
            onClick={props.onApplyLayout}
            variant="plain"
          >
            {props.labels.applyLayout}
          </Button>
        ) : null}
        <Button
          onClick={props.onExportMmd}
          prefix={<DownloadIcon />}
          variant="plain"
        >
          {props.labels.exportMmd}
        </Button>
      </Stack>
    );
    return (
      <Menu
        items={
          props.embedded ? (
            embeddedDiagramActions
          ) : (
            <Stack gap="xs">
              <>
                <MermaidFlowchartNodeActions pageMore props={props} />
                <MermaidFlowchartEdgeActions pageMore props={props} />
                <MermaidFlowchartSubgraphActions pageMore props={props} />
              </>
              <MermaidFlowchartAccessibility embedded props={props} />
              {props.canApplyLayout ? (
                <Button
                  disabled={props.readonly}
                  onClick={props.onApplyLayout}
                  variant="plain"
                >
                  {props.labels.applyLayout}
                </Button>
              ) : null}
            </Stack>
          )
        }
        title={props.labels.moreActions}
      >
        <IconButton
          aria-label={props.labels.moreActions}
          icon={<MoreHorizontalIcon />}
          tooltip={props.labels.moreActions}
        />
      </Menu>
    );
  }
  return null;
}

function MermaidFlowchartEmbeddedDiagramActions({
  props,
}: {
  readonly props: MermaidFlowchartReactHostProps;
}) {
  const multipleSelected = props.selectionCount > 1;
  return (
    <MermaidEmbeddedActions
      actions={
        <>
          {!multipleSelected && props.placementHint ? (
            <Box aria-live="polite" role="status">
              <MyoxusText typographySlot="body-small">
                {props.placementHint}
              </MyoxusText>
            </Box>
          ) : null}
          {!props.readonly && !multipleSelected && props.pageSelection ? (
            <MermaidPageSelectionToolControls
              labels={props.labels}
              pageSelection={props.pageSelection}
            />
          ) : null}
          {!props.readonly && !multipleSelected ? (
            <SplitMenuButton
              actionIcon={<PlusIcon />}
              fluid={false}
              label={props.labels.addElement}
              menuAriaLabel={props.labels.shapeMenu}
              menuItems={
                <MenuScrollableSection maxHeight="default">
                  {props.shapeOptions.map((option) => (
                    <MenuItem
                      aria-label={option.actionLabel}
                      key={option.value}
                      onSelect={() => props.onNodeShapeChange(option.value)}
                      prefixIcon={shapeIcon(option.value)}
                      selected={props.pendingShape === option.value}
                    >
                      {option.label}
                    </MenuItem>
                  ))}
                </MenuScrollableSection>
              }
              onClick={props.onAddNode}
              variant="secondary"
            />
          ) : null}
          {multipleSelected ? (
            <>
              {props.typography ? (
                <FlowchartTextFormatting props={props.typography} />
              ) : null}
              <MermaidFlowchartPageAction
                props={{ ...props, projection: "add-subgraph" }}
              />
              {props.canConnect ? (
                <MermaidFlowchartPageAction
                  props={{ ...props, projection: "connect" }}
                />
              ) : null}
              <MermaidSelectionDeleteAction
                action={props.selectionAction}
                resolveReturnFocusTarget={props.resolveReturnFocusTarget}
              />
            </>
          ) : null}
          {!multipleSelected ? (
            <>
              <MermaidFlowchartPageAction
                props={{ ...props, projection: "connect" }}
              />
              <MermaidFlowchartPageAction
                props={{ ...props, projection: "add-subgraph" }}
              />
              <MermaidFlowchartPageAction
                props={{ ...props, projection: "more" }}
              />
            </>
          ) : null}
        </>
      }
      label={props.labels.toolbar}
    />
  );
}

export function MermaidFlowchartRuntimeSurface({
  props,
}: {
  readonly props: MermaidFlowchartReactHostProps;
}) {
  if (props.projection !== "surface") return null;
  const diagramComments = props.comments.filter(
    (comment) => comment.anchorKind === "diagram",
  );

  return (
    <MermaidGfxEditorWorkbench
      isolateEvents={!props.embedded}
      pageViewport={props.embedded ? undefined : props.pageViewport}
      embeddedActions={
        props.embedded &&
        props.embeddedEditing &&
        !props.displayOnly &&
        !props.readonly ? (
          <MermaidFlowchartEmbeddedDiagramActions props={props} />
        ) : null
      }
      onEmbeddedActionsInsetChange={props.onEmbeddedActionsInsetChange}
      onWorkareaResize={props.onWorkareaResize}
      resolveReturnFocusTarget={props.resolveReturnFocusTarget}
      selectionKey={props.selectionKey}
      selectionControls={
        <>
          {props.displayOnly && diagramComments.length ? (
            <Box
              data-myoxus-ui-role="mermaid-flowchart-diagram-comments"
              pos="absolute"
              style={{
                left: "var(--mantine-spacing-xs)",
                top: "var(--mantine-spacing-xs)",
                zIndex: 25,
              }}
            >
              <MermaidFlowchartComments
                comments={diagramComments}
                marker
                props={props}
              />
            </Box>
          ) : null}
          {props.displayOnly ||
          (props.embedded && props.selectionCount === 1) ? (
            <>
              <MermaidFlowchartNodeActions props={props} />
              <MermaidFlowchartEdgeActions props={props} />
              <MermaidFlowchartSubgraphActions props={props} />
            </>
          ) : null}
        </>
      }
      workarea={props.workarea}
      workareaFooter={props.workareaFooter}
      workareaAccessibilityDescription={props.accessibilityDescription}
      workareaAccessibilityTitle={props.accessibilityTitle}
      workareaHeader={null}
      workareaLabel={props.labels.toolbar}
    />
  );
}

export function createMermaidFlowchartRendererRegistration(
  reactToLit: ReactToLit,
): MermaidFamilyReactRendererRegistration<MermaidFlowchartReactRendererProps> {
  const nativeView = (props: MermaidFlowchartReactRendererProps) =>
    "kind" in props && props.kind === "typography" ? (
      <FlowchartTextFormatting props={props} />
    ) : "kind" in props ? (
      <MermaidFlowchartMetadataAction props={props} />
    ) : props.projection === "surface" ? (
      <MermaidFlowchartRuntimeSurface props={props} />
    ) : (
      <MermaidFlowchartPageAction props={props} />
    );
  return {
    token: mermaidFlowchartRendererToken,
    nativeView,
    render: (props) => reactToLit(nativeView(props), true),
  };
}
