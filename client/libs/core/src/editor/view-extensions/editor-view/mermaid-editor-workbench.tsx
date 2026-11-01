// SPDX-License-Identifier: AGPL-3.0-or-later

import { useI18n } from "@myoxus/i18n";
import {
  LocateIcon,
  RedoIcon,
  SelectAreaIcon,
  SelectIcon,
  TrashIcon,
  UndoIcon,
  WorkflowIcon,
} from "@myoxus/icons";
import { toReactNode } from "@myoxus/lit-react";
import {
  Alert,
  Box,
  Button,
  Card,
  ConfirmModal,
  Group,
  IconButton,
  IconButtonGroup,
  InlineEdit,
  MyoxusSegmentedControl,
  MyoxusSelect,
  MyoxusText,
  Scrollable,
  Stack,
  Textarea,
  ThemeIcon,
  Tooltip,
  WorkbenchContextPanelLayout,
} from "@myoxus/ui-facade";
import {
  createMermaidSourceEditIntent,
  isMermaidPageZoom,
  MERMAID_PAGE_FIXED_ZOOMS,
  resolveMermaidPageZoomStep,
  type MermaidBlockShellReactHostProps,
  type MermaidEmbeddedTitleReactHostProps,
  type MermaidPageViewportProjection,
  type MermaidPageSelectionProjection,
  type MermaidSelectionActionModel,
  type MermaidShellNoticeReactHostProps,
} from "@virgultum/block-mermaid";
import { isTouchPadPinchEvent } from "@virgultum/shared/utils";
import {
  type CompositionEvent,
  type KeyboardEvent,
  type PropsWithChildren,
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
  useCallback,
  useContext,
  useState,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { createPortal } from "react-dom";

import { ReadingSnapshotContext } from "../../virgultum/doc-editor/reading-snapshot-context";

export function MermaidEmbeddedTitle({
  props,
}: {
  readonly props: MermaidEmbeddedTitleReactHostProps;
}) {
  const titleVisible = props.titlePresentation?.visible !== false;
  return (
    <Group
      data-myoxus-ui-role="mermaid-embedded-title"
      gap="xs"
      p={titleVisible ? "xs" : undefined}
      wrap="nowrap"
    >
      {titleVisible ? (
        <ThemeIcon>
          <WorkflowIcon />
        </ThemeIcon>
      ) : null}
      {titleVisible ? (
        <MyoxusText
          component="div"
          style={{
            fontSize: props.titlePresentation?.fontSize,
            paddingBlock: props.titlePresentation?.padding,
          }}
          typographySlot="label-strong"
        >
          <Tooltip content={props.title || props.placeholder}>
            <Box miw={0}>
              <InlineEdit
                displayLineClamp={1}
                editable={!props.readonly}
                inputAttrs={{ "aria-label": props.placeholder }}
                onChange={props.onTitleChange}
                placeholder={props.placeholder}
                value={props.title}
              />
            </Box>
          </Tooltip>
        </MyoxusText>
      ) : null}
      <Group ref={props.onActionTargetChange} />
    </Group>
  );
}

export function useMermaidSelectionAction({
  confirmation,
  disabled,
  label,
  onSelect,
  register,
  selectionKey,
}: {
  readonly confirmation?: MermaidSelectionActionModel["confirmation"];
  readonly disabled: boolean;
  readonly label: string;
  readonly onSelect: () => void;
  readonly register: (action: MermaidSelectionActionModel | null) => void;
  readonly selectionKey: string | null | undefined;
}) {
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const confirmationKey = JSON.stringify(confirmation ?? null);
  const confirmationRef = useRef<{
    key: string;
    value: MermaidSelectionActionModel["confirmation"];
  }>({ key: confirmationKey, value: confirmation });
  if (confirmationRef.current.key !== confirmationKey) {
    confirmationRef.current = { key: confirmationKey, value: confirmation };
  }
  const stableConfirmation = confirmationRef.current.value;
  const action = useMemo<MermaidSelectionActionModel | null>(
    () =>
      selectionKey
        ? {
            confirmation: stableConfirmation,
            disabled,
            label,
            onSelect: () => onSelectRef.current(),
          }
        : null,
    [disabled, label, selectionKey, stableConfirmation],
  );
  useEffect(() => {
    register(action);
    return () => register(null);
  }, [action, register]);
}

export function MermaidSelectionDeleteAction({
  action,
  onInvokerChange,
  resolveReturnFocusTarget,
}: {
  readonly action: MermaidSelectionActionModel | null;
  readonly onInvokerChange?: (invoke: (() => void) | null) => void;
  readonly resolveReturnFocusTarget?: () => HTMLElement | null;
}) {
  const t = useI18n();
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const disabled = !action || action.disabled;
  const invoke = useCallback(() => {
    if (disabled || !action) return;
    if (action.confirmation) setConfirmationOpen(true);
    else action.onSelect();
  }, [action, disabled]);

  useEffect(() => {
    onInvokerChange?.(invoke);
    return () => onInvokerChange?.(null);
  }, [invoke, onInvokerChange]);

  const label = action?.label ?? t["Delete"]();
  return (
    <>
      <IconButton
        aria-label={label}
        disabled={disabled}
        icon={<TrashIcon />}
        onClick={invoke}
        tooltip={label}
      />
      <ConfirmModal
        cancelText={t["Cancel"]()}
        confirmButtonOptions={{ variant: "destructive" }}
        confirmText={label}
        onConfirm={() => {
          action?.onSelect();
          resolveReturnFocusTarget?.()?.focus();
        }}
        onOpenChange={setConfirmationOpen}
        open={confirmationOpen}
        title={label}
      >
        {action?.confirmation ? (
          <Stack gap="xs">
            <MyoxusText>{action.confirmation.description}</MyoxusText>
            {action.confirmation.items?.map((item) => (
              <MyoxusText key={item}>{item}</MyoxusText>
            ))}
          </Stack>
        ) : null}
      </ConfirmModal>
    </>
  );
}

type MermaidEditorWorkbenchProps = PropsWithChildren<{
  readonly actionTarget?: HTMLElement | null;
  readonly bubbleUnhandledEscape?: boolean;
  readonly context?: ReactNode;
  readonly contextCompact?: boolean;
  readonly contextOpened?: boolean;
  readonly contextTitle?: ReactNode;
  readonly embeddedActions?: ReactNode;
  readonly isolateEvents?: boolean;
  readonly onContextOpenChange?: (opened: boolean) => void;
  readonly onEscape?: () => boolean;
  readonly pageViewport?: MermaidPageViewportProjection;
  readonly pageViewportAdapter?: "dom" | "gfx";
  readonly returnFocusRef?: RefObject<HTMLElement | null>;
  readonly toolbar?: ReactNode;
  readonly workareaLabel?: string;
}>;

/**
 * Thin Mermaid adapter for the existing Workbench context contract. Mantine
 * Grid and WorkbenchContextPanelSurface own layout, compact Drawer behavior
 * and focus restoration; family runtimes own only actions, workarea and
 * inspector content.
 */
export function MermaidEditorWorkbench({
  bubbleUnhandledEscape = false,
  children,
  context,
  contextCompact,
  contextOpened,
  contextTitle,
  embeddedActions,
  isolateEvents = true,
  onContextOpenChange,
  onEscape,
  pageViewport,
  pageViewportAdapter = "dom",
  returnFocusRef,
  toolbar,
  workareaLabel,
  actionTarget,
}: MermaidEditorWorkbenchProps) {
  const t = useI18n();
  const stopOwnedPointerEvent = (event: SyntheticEvent<HTMLDivElement>) => {
    // Embedded Note gestures still bubble. Portalled forms belong to this
    // workbench, rather than to the canvas behind their DOM location.
    if (
      isolateEvents ||
      (event.target instanceof Node &&
        !event.currentTarget.contains(event.target))
    )
      event.stopPropagation();
  };
  const pageWorkarea = pageViewport ? (
    <MermaidPageViewport
      adapter={pageViewportAdapter}
      label={workareaLabel ?? contextTitle}
      projection={pageViewport}
    >
      {children}
    </MermaidPageViewport>
  ) : (
    children
  );
  const workarea =
    context === undefined ? (
      pageWorkarea
    ) : (
      <WorkbenchContextPanelLayout
        closeButtonLabel={t["com.myoxus.peek-view-controls.close"]()}
        compact={contextCompact}
        context={context}
        contextOpened={Boolean(contextOpened)}
        contextTitle={contextTitle}
        onContextOpenChange={onContextOpenChange ?? (() => undefined)}
        returnFocusRef={returnFocusRef}
      >
        {pageWorkarea}
      </WorkbenchContextPanelLayout>
    );

  return (
    <Stack
      data-myoxus-ui-role="mermaid-editor-workbench"
      gap={0}
      onClick={stopOwnedPointerEvent}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          let handled = onEscape?.() ?? false;
          if (!handled && contextOpened) {
            onContextOpenChange?.(false);
            handled = true;
          }
          if (handled || !bubbleUnhandledEscape) event.stopPropagation();
        }
      }}
      onMouseDown={stopOwnedPointerEvent}
      onPointerDown={stopOwnedPointerEvent}
    >
      {actionTarget === undefined
        ? toolbar
        : actionTarget && toolbar
          ? createPortal(toolbar, actionTarget)
          : null}
      {embeddedActions ? (
        <Box pos="relative">
          {workarea}
          {embeddedActions}
        </Box>
      ) : (
        workarea
      )}
    </Stack>
  );
}

type MermaidGfxEditorWorkbenchProps = {
  readonly actionTarget?: HTMLElement | null;
  readonly context?: ReactNode;
  readonly contextOpened?: boolean;
  readonly contextTitle?: ReactNode;
  readonly embeddedActions?: ReactNode;
  readonly isolateEvents?: boolean;
  readonly onEmbeddedActionsInsetChange?: (height: number) => void;
  readonly onCloseContext?: () => void;
  readonly onEscape?: () => boolean;
  readonly onWorkareaResize: () => void;
  readonly pageViewport?: MermaidPageViewportProjection;
  readonly resolveReturnFocusTarget: () => HTMLElement | null;
  readonly selectionKey: string;
  readonly selectionControls?: ReactNode;
  readonly toolbar?: ReactNode;
  readonly workarea: Parameters<typeof toReactNode>[0] | null;
  readonly workareaFooter?: Parameters<typeof toReactNode>[0] | null;
  readonly workareaAccessibilityDescription?: string;
  readonly workareaAccessibilityTitle?: string;
  readonly workareaHeader?: ReactNode;
  readonly workareaLabel?: string;
};

export function MermaidGfxEditorWorkbench({
  actionTarget,
  context,
  contextOpened,
  contextTitle,
  embeddedActions,
  isolateEvents,
  onCloseContext,
  onEmbeddedActionsInsetChange,
  onEscape,
  onWorkareaResize,
  pageViewport,
  resolveReturnFocusTarget,
  selectionKey,
  selectionControls,
  toolbar,
  workarea,
  workareaFooter,
  workareaAccessibilityDescription,
  workareaAccessibilityTitle,
  workareaHeader,
  workareaLabel,
}: MermaidGfxEditorWorkbenchProps) {
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const workareaRef = useRef<HTMLDivElement | null>(null);
  const [overlayTarget, setOverlayTarget] = useState<HTMLElement | null>(null);
  const onWorkareaResizeRef = useRef(onWorkareaResize);
  onWorkareaResizeRef.current = onWorkareaResize;
  const onEmbeddedActionsInsetChangeRef = useRef(onEmbeddedActionsInsetChange);
  onEmbeddedActionsInsetChangeRef.current = onEmbeddedActionsInsetChange;
  const hasEmbeddedActions = Boolean(embeddedActions);

  useEffect(() => {
    if (contextOpened) returnFocusRef.current = resolveReturnFocusTarget();
  }, [contextOpened, resolveReturnFocusTarget]);

  useEffect(() => {
    let secondFrame: number | undefined;
    const update = () => {
      onWorkareaResizeRef.current();
      // GFX anchors are viewport-local. The Page scroll plane independently
      // positions the canvas, so placing overlays on that plane scrolls twice.
      setOverlayTarget(
        workareaRef.current?.querySelector<HTMLElement>(
          ".myoxus-mermaid-gfx-viewport",
        ) ?? null,
      );
    };
    const firstFrame = requestAnimationFrame(() => {
      update();
      secondFrame = requestAnimationFrame(update);
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame !== undefined) cancelAnimationFrame(secondFrame);
    };
  }, [contextOpened, selectionKey]);

  useEffect(() => {
    const workareaElement = workareaRef.current;
    const actionsElement = workareaElement?.querySelector<HTMLElement>(
      '[data-myoxus-ui-role="mermaid-embedded-actions"]',
    );
    if (!actionsElement) {
      onEmbeddedActionsInsetChangeRef.current?.(0);
      return;
    }
    const reportInset = () => {
      onEmbeddedActionsInsetChangeRef.current?.(actionsElement.offsetHeight);
    };
    reportInset();
    if (typeof ResizeObserver === "undefined") return;
    let frame: number | undefined;
    // Reporting the inset can refit the nested GFX viewport. Defer that layout
    // work beyond ResizeObserver delivery rather than resizing its own cycle.
    const observer = new ResizeObserver(() => {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        reportInset();
      });
    });
    observer.observe(actionsElement);
    return () => {
      observer.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
      onEmbeddedActionsInsetChangeRef.current?.(0);
    };
  }, [hasEmbeddedActions]);

  return (
    <>
      <MermaidEditorWorkbench
        actionTarget={actionTarget}
        bubbleUnhandledEscape={isolateEvents === false}
        context={context}
        contextOpened={contextOpened}
        contextTitle={contextTitle}
        isolateEvents={isolateEvents}
        onContextOpenChange={(opened) => {
          if (!opened) onCloseContext?.();
        }}
        onEscape={
          isolateEvents === false
            ? onEscape
            : () => {
                if (onEscape) return onEscape();
                if (selectionKey && onCloseContext) {
                  onCloseContext();
                  return true;
                }
                return false;
              }
        }
        pageViewport={pageViewport}
        pageViewportAdapter="gfx"
        returnFocusRef={returnFocusRef}
        toolbar={toolbar}
        workareaLabel={workareaAccessibilityTitle ?? workareaLabel}
      >
        {workareaAccessibilityTitle || workareaAccessibilityDescription ? (
          <Box pos="relative" ref={workareaRef}>
            <Stack
              aria-description={workareaAccessibilityDescription || undefined}
              aria-label={workareaAccessibilityTitle || undefined}
              gap={0}
              role="group"
            >
              {workareaHeader}
              {workarea ? toReactNode(workarea) : null}
            </Stack>
            {overlayTarget && selectionControls
              ? createPortal(selectionControls, overlayTarget)
              : null}
            {embeddedActions}
          </Box>
        ) : (
          <Box pos="relative" ref={workareaRef}>
            {workareaHeader}
            {workarea ? toReactNode(workarea) : null}
            {overlayTarget && selectionControls
              ? createPortal(selectionControls, overlayTarget)
              : null}
            {embeddedActions}
          </Box>
        )}
      </MermaidEditorWorkbench>
      {workareaFooter ? toReactNode(workareaFooter) : null}
    </>
  );
}

function MermaidEditorShellHeader({
  props,
  readingSnapshot,
}: {
  readonly props: MermaidBlockShellReactHostProps;
  readonly readingSnapshot: boolean;
}) {
  const titleVisible = props.titlePresentation?.visible !== false;
  const typeLabelVisible = !titleVisible || !props.title.trim();
  const modeData = [
    ...(props.showView
      ? [{ label: props.labels.view, value: "view" as const }]
      : []),
    ...(props.sourceFirst
      ? []
      : [{ label: props.labels.visual, value: "visual" as const }]),
    { label: props.labels.source, value: "source" as const },
  ];
  const zoomData = [
    { label: props.labels.pageZoomAuto, value: "auto" },
    ...MERMAID_PAGE_FIXED_ZOOMS.map((percent) => ({
      label: props.labels.pageZoomPercent(percent),
      value: String(percent),
    })),
  ];

  return (
    <Group
      data-myoxus-ui-role="mermaid-editor-shell-header"
      justify="space-between"
      p="sm"
      wrap="wrap"
    >
      <Group flex={{ base: "1 1 100%", xs: "1 1 auto" }} miw={0} wrap="nowrap">
        <ThemeIcon>
          <WorkflowIcon />
        </ThemeIcon>
        <Stack flex={1} gap={0} miw={0}>
          {typeLabelVisible ? (
            <MyoxusText
              lineClamp={1}
              tone="secondary"
              typographySlot="body-small"
            >
              {props.typeLabel}
            </MyoxusText>
          ) : null}
          <Group gap="xs" wrap="nowrap">
            {titleVisible ? (
              <MyoxusText
                component="div"
                style={{
                  fontSize: props.titlePresentation?.fontSize,
                  paddingBlock: props.titlePresentation?.padding,
                }}
                typographySlot="label-strong"
              >
                <Tooltip content={props.title || props.labels.titlePlaceholder}>
                  <Box miw={0}>
                    <InlineEdit
                      displayLineClamp={1}
                      editable={!props.readonly}
                      inputAttrs={{
                        "aria-label": props.labels.titlePlaceholder,
                      }}
                      onChange={props.onTitleChange}
                      placeholder={props.labels.titlePlaceholder}
                      value={props.title}
                    />
                  </Box>
                </Tooltip>
              </MyoxusText>
            ) : null}
            {!readingSnapshot ? (
              <Group ref={props.onHeaderActionTargetChange} />
            ) : null}
          </Group>
        </Stack>
      </Group>
      {!readingSnapshot ? (
        <Group
          flex={{ base: "1 1 100%", xs: "0 0 auto" }}
          justify="flex-end"
          wrap="nowrap"
        >
          {props.showPageViewportControls ? (
            <MyoxusSelect
              aria-description={props.labels.pageZoomHelp}
              aria-label={props.labels.pageZoom}
              contentSized
              data={zoomData}
              data-myoxus-ui-role="mermaid-page-zoom-control"
              disabled={props.pageZoomDisabled}
              onChange={(value) => {
                const zoom = value === "auto" ? value : Number(value);
                if (!isMermaidPageZoom(zoom)) return;
                props.onPageZoomChange({
                  anchor: { type: "center" },
                  source: "select",
                  zoom,
                });
              }}
              value={String(props.pageZoom)}
            />
          ) : null}
          <Box flex="0 0 auto">
            <MyoxusSegmentedControl
              aria-label={props.labels.controls}
              data={modeData}
              data-myoxus-ui-role="mermaid-editor-mode-control"
              disabled={props.modeDisabled ?? props.readonly}
              onChange={(mode) => props.onModeChange(mode as typeof props.mode)}
              value={props.mode}
            />
          </Box>
        </Group>
      ) : null}
    </Group>
  );
}

function MermaidPageViewport({
  adapter,
  children,
  label,
  projection,
}: PropsWithChildren<{
  readonly adapter: "dom" | "gfx";
  readonly label?: ReactNode;
  readonly projection: MermaidPageViewportProjection;
}>) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [viewportMaxHeight, setViewportMaxHeight] = useState<number | null>(
    null,
  );
  const [viewportTop, setViewportTop] = useState(0);
  const scaleRef = useRef(projection.state.resolvedScales[projection.mode]);
  const zoomRevisionRef = useRef(0);
  const callbacksRef = useRef(projection);
  callbacksRef.current = projection;
  const pageZoom = projection.state.zoom;
  const viewportMode = projection.mode;
  const resolvedScale = projection.state.resolvedScales[viewportMode];

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const position = projection.state.positions[viewportMode];
    viewport.scrollTo(position.scrollLeft, position.scrollTop);
  }, [projection.state.positions, viewportMode]);

  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    const update = () => {
      const available = content.offsetWidth > 0 && content.offsetHeight > 0;
      callbacksRef.current.onAvailabilityChange(available);
      if (!available) return;
      if (adapter === "gfx") {
        const editor = content.querySelector<HTMLElement>(
          ".myoxus-mermaid-gfx-editor",
        );
        const naturalWidth = Number(editor?.dataset.mermaidPageNaturalWidth);
        const naturalHeight = Number(editor?.dataset.mermaidPageNaturalHeight);
        const scale = pageZoom === "auto" ? resolvedScale : pageZoom / 100;
        const editorHeight = Math.round(
          editor?.getBoundingClientRect().height ?? 0,
        );
        if (editorHeight > 0) {
          setViewportMaxHeight((current) =>
            current === editorHeight ? current : editorHeight,
          );
        }
        if (
          editor &&
          Number.isFinite(naturalWidth) &&
          naturalWidth > 0 &&
          Number.isFinite(naturalHeight) &&
          naturalHeight > 0 &&
          scale > 0
        ) {
          const previousScale = scaleRef.current;
          const navigation =
            callbacksRef.current.resolveNavigationGeometry(scale);
          content.style.width = `${Math.max(
            viewport.clientWidth,
            navigation?.width ?? naturalWidth * scale,
          )}px`;
          content.style.height = `${Math.max(
            editorHeight,
            navigation?.height ?? naturalHeight * scale,
          )}px`;
          content.style.position = "relative";
          editor.style.position = "absolute";
          editor.style.insetInlineStart = `${viewport.scrollLeft}px`;
          editor.style.top = `${viewport.scrollTop}px`;
          editor.style.width = `${viewport.clientWidth}px`;
          if (pageZoom !== "auto") {
            callbacksRef.current.onResolvedScaleChange(scale);
          }
          const change = callbacksRef.current.state.zoomChange;
          if (
            change &&
            change.revision !== zoomRevisionRef.current &&
            previousScale > 0
          ) {
            const rect = viewport.getBoundingClientRect();
            const ownsChange = change.mode === viewportMode;
            const anchorX =
              ownsChange && change.intent.anchor.type === "pointer"
                ? change.intent.anchor.clientX - rect.left
                : viewport.clientWidth / 2;
            const anchorY =
              ownsChange && change.intent.anchor.type === "pointer"
                ? change.intent.anchor.clientY - rect.top
                : viewport.clientHeight / 2;
            const previousNavigation =
              callbacksRef.current.resolveNavigationGeometry(previousScale);
            const previousInsetX =
              previousNavigation?.insetLeft ??
              Math.max(
                0,
                (viewport.clientWidth - naturalWidth * previousScale) / 2,
              );
            const previousInsetY =
              previousNavigation?.insetTop ??
              Math.max(
                0,
                (viewport.clientHeight - naturalHeight * previousScale) / 2,
              );
            const nextInsetX =
              navigation?.insetLeft ??
              Math.max(0, (viewport.clientWidth - naturalWidth * scale) / 2);
            const nextInsetY =
              navigation?.insetTop ??
              Math.max(0, (viewport.clientHeight - naturalHeight * scale) / 2);
            const contentX =
              (viewport.scrollLeft + anchorX - previousInsetX) / previousScale;
            const contentY =
              (viewport.scrollTop + anchorY - previousInsetY) / previousScale;
            viewport.scrollTo(
              contentX * scale + nextInsetX - anchorX,
              contentY * scale + nextInsetY - anchorY,
            );
            zoomRevisionRef.current = change.revision;
          } else {
            // Measurement must not replace a newer camera intent with the
            // DOM's previous offset. Apply it against the updated extent first;
            // the zoom branch above owns its pointer-adjusted scroll position.
            const position = callbacksRef.current.state.positions[viewportMode];
            viewport.scrollTo(position.scrollLeft, position.scrollTop);
          }
          callbacksRef.current.onPositionChange({
            scrollLeft: viewport.scrollLeft,
            scrollTop: viewport.scrollTop,
          });
          scaleRef.current = scale;
        }
        return;
      }
      // DOM diagrams share this sole scroll plane. Bound its actual rendered origin,
      // so a tall board cannot place the native horizontal scrollbar below the desktop.
      // This is renderer navigation geometry; Mantine still owns layout and both scrollbars.
      const top = Math.max(0, viewport.getBoundingClientRect().top);
      setViewportTop((current) => (current === top ? current : top));
      const naturalWidth = content.offsetWidth;
      const naturalHeight = content.offsetHeight;
      setViewportMaxHeight((current) =>
        current === naturalHeight ? current : naturalHeight,
      );
      const widthScale = viewport.clientWidth / naturalWidth;
      const heightScale = viewport.clientHeight / naturalHeight;
      const autoScale = Math.min(
        widthScale,
        Number.isFinite(heightScale) && heightScale > 0
          ? heightScale
          : widthScale,
      );
      const scale =
        pageZoom === "auto"
          ? Number.isFinite(autoScale) && autoScale > 0
            ? autoScale
            : 1
          : pageZoom / 100;
      const previousScale = scaleRef.current;
      content.style.zoom = String(scale);
      callbacksRef.current.onResolvedScaleChange(scale);
      const change = callbacksRef.current.state.zoomChange;
      if (
        change &&
        change.revision !== zoomRevisionRef.current &&
        previousScale > 0 &&
        scale > 0
      ) {
        const rect = viewport.getBoundingClientRect();
        const ownsChange = change.mode === viewportMode;
        const anchorX =
          ownsChange && change.intent.anchor.type === "pointer"
            ? change.intent.anchor.clientX - rect.left
            : viewport.clientWidth / 2;
        const anchorY =
          ownsChange && change.intent.anchor.type === "pointer"
            ? change.intent.anchor.clientY - rect.top
            : viewport.clientHeight / 2;
        const ratio = scale / previousScale;
        viewport.scrollTo(
          (viewport.scrollLeft + anchorX) * ratio - anchorX,
          (viewport.scrollTop + anchorY) * ratio - anchorY,
        );
        zoomRevisionRef.current = change.revision;
      }
      scaleRef.current = scale;
    };
    update();
    let resizeFrame: number | undefined;
    const scheduleUpdate = () => {
      if (resizeFrame !== undefined) return;
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = undefined;
        update();
      });
    };
    const observer = new ResizeObserver(scheduleUpdate);
    observer.observe(viewport);
    observer.observe(content);
    let observedEditor: HTMLElement | null = null;
    const observeEditor = () => {
      const editor = content.querySelector<HTMLElement>(
        ".myoxus-mermaid-gfx-editor",
      );
      if (editor === observedEditor) return false;
      if (observedEditor) observer.unobserve(observedEditor);
      observedEditor = editor;
      if (editor) observer.observe(editor);
      return true;
    };
    // The GFX editor is absolutely positioned on the scroll plane. Its
    // user-resized height does not resize that plane, so observe it directly
    // to keep the existing Facade viewport's maximum height in sync.
    if (adapter === "gfx") observeEditor();
    // Source can change natural bounds or replace the absolute GFX shell
    // without resizing the scroll plane. Track its published bounds and rebind
    // the size observer so selection reveal uses the current scroll extent.
    const geometryObserver =
      adapter === "gfx"
        ? new MutationObserver((records) => {
            const replaced = observeEditor();
            if (
              replaced ||
              records.some((record) => record.type === "attributes")
            )
              scheduleUpdate();
          })
        : null;
    geometryObserver?.observe(content, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "data-mermaid-page-natural-width",
        "data-mermaid-page-natural-height",
      ],
    });
    // Ancestor scrolling can move the plane without changing its content size.
    if (adapter === "dom")
      document.addEventListener("scroll", scheduleUpdate, true);
    return () => {
      if (adapter === "dom")
        document.removeEventListener("scroll", scheduleUpdate, true);
      observer.disconnect();
      geometryObserver?.disconnect();
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
    };
  }, [
    adapter,
    pageZoom,
    resolvedScale,
    viewportMode,
    projection.navigationRevision,
  ]);

  useEffect(
    () => () => callbacksRef.current.onAvailabilityChange(false),
    [viewportMode],
  );

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || projection.state.centerRevisions[viewportMode] === 0)
      return;
    const target = (adapter === "gfx"
      ? callbacksRef.current.resolveCenterPosition()
      : null) ?? {
      scrollLeft: (viewport.scrollWidth - viewport.clientWidth) / 2,
      scrollTop: (viewport.scrollHeight - viewport.clientHeight) / 2,
    };
    viewport.scrollTo(target.scrollLeft, target.scrollTop);
    // Programmatic scroll does not emit when the target already matches the
    // thumb. Project the clamped DOM position explicitly so the GFX camera and
    // the sole Page scroll owner cannot retain divergent center states.
    callbacksRef.current.onPositionChange({
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop,
    });
  }, [adapter, projection.state.centerRevisions, viewportMode]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const handleWheel = (wheel: WheelEvent) => {
      if (!isTouchPadPinchEvent(wheel) || wheel.deltaY === 0) return;
      const current = callbacksRef.current;
      const zoom = resolveMermaidPageZoomStep(
        current.state.zoom,
        current.state.resolvedScales[current.mode],
        {
          direction: wheel.deltaY < 0 ? 1 : -1,
          type: "step",
        },
      );
      if (zoom === current.state.zoom) return;
      wheel.preventDefault();
      wheel.stopPropagation();
      current.onZoomChange({
        anchor: {
          clientX: wheel.clientX,
          clientY: wheel.clientY,
          type: "pointer",
        },
        source: "wheel",
        zoom,
      });
    };
    // React delegates wheel events through a passive root listener. This
    // viewport is the actual gesture owner and must be able to consume only a
    // modifier/pinch zoom while leaving ordinary scroll and edge chaining
    // native.
    viewport.addEventListener("wheel", handleWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", handleWheel);
  }, []);

  return (
    <Scrollable.Viewport
      aria-label={typeof label === "string" ? label : undefined}
      autosize
      data-myoxus-ui-role="mermaid-page-scroll-viewport"
      onScroll={(event) => {
        if (adapter === "gfx") {
          const editor = contentRef.current?.querySelector<HTMLElement>(
            ".myoxus-mermaid-gfx-editor",
          );
          if (editor) {
            editor.style.insetInlineStart = `${event.currentTarget.scrollLeft}px`;
            editor.style.top = `${event.currentTarget.scrollTop}px`;
          }
        }
        projection.onPositionChange({
          scrollLeft: event.currentTarget.scrollLeft,
          scrollTop: event.currentTarget.scrollTop,
        });
      }}
      ref={viewportRef}
      maxHeight={
        adapter === "dom" && viewportMaxHeight !== null
          ? `min(${viewportMaxHeight}px, calc(100dvh - ${viewportTop}px - var(--mantine-spacing-md)))`
          : (viewportMaxHeight ?? undefined)
      }
      scrollbars="xy"
      scrollbarVisibility="auto"
    >
      <div
        data-mermaid-page-viewport-adapter={adapter}
        data-myoxus-ui-role="mermaid-page-content-plane"
        ref={contentRef}
      >
        {children}
      </div>
    </Scrollable.Viewport>
  );
}

function MermaidSourceEditor({
  props,
}: {
  readonly props: MermaidBlockShellReactHostProps;
}) {
  const [draft, setDraft] = useState(props.source);
  const composingRef = useRef(false);
  const lastPropsSourceRef = useRef(props.source);
  const lastSentRef = useRef<string | null>(null);

  useEffect(() => {
    if (lastSentRef.current === props.source) {
      lastSentRef.current = null;
      lastPropsSourceRef.current = props.source;
      return;
    }
    if (lastPropsSourceRef.current !== props.source) {
      lastSentRef.current = null;
      lastPropsSourceRef.current = props.source;
      setDraft(props.source);
    }
  }, [props.source]);

  const commit = useCallback(
    (source: string) => {
      if (lastSentRef.current === source) return;
      lastSentRef.current = source;
      props.onSourceEdit(createMermaidSourceEditIntent(source));
    },
    [props],
  );
  const stopAtSourceBoundary = useCallback(
    (event: { stopPropagation: () => void }) => event.stopPropagation(),
    [],
  );
  const handleCompositionEnd = useCallback(
    (event: CompositionEvent<HTMLTextAreaElement>) => {
      event.stopPropagation();
      composingRef.current = false;
      const source = event.currentTarget.value;
      setDraft(source);
      commit(source);
    },
    [commit],
  );

  return (
    <Textarea
      aria-label={props.labels.editor}
      autosize
      maxRows={40}
      minRows={15}
      mono
      onBeforeInput={stopAtSourceBoundary}
      onChange={(source) => {
        setDraft(source);
        if (!composingRef.current) commit(source);
      }}
      onClick={stopAtSourceBoundary}
      onCompositionEnd={handleCompositionEnd}
      onCompositionStart={(event) => {
        event.stopPropagation();
        composingRef.current = true;
      }}
      onCompositionUpdate={stopAtSourceBoundary}
      onContextMenu={stopAtSourceBoundary}
      onCopy={stopAtSourceBoundary}
      onCut={stopAtSourceBoundary}
      onDoubleClick={stopAtSourceBoundary}
      onBlur={stopAtSourceBoundary}
      onFocus={stopAtSourceBoundary}
      onInput={stopAtSourceBoundary}
      onKeyDown={stopAtSourceBoundary}
      onKeyPress={stopAtSourceBoundary}
      onKeyUp={stopAtSourceBoundary}
      onMouseDown={stopAtSourceBoundary}
      onMouseUp={stopAtSourceBoundary}
      onPaste={stopAtSourceBoundary}
      onPointerCancel={stopAtSourceBoundary}
      onPointerDown={stopAtSourceBoundary}
      onPointerMove={stopAtSourceBoundary}
      onPointerOut={stopAtSourceBoundary}
      onPointerUp={stopAtSourceBoundary}
      onSelect={stopAtSourceBoundary}
      placeholder={props.labels.sourcePlaceholder}
      readOnly={props.readonly}
      spellCheck={false}
      value={draft}
    />
  );
}

export function MermaidPageSelectionToolControls({
  labels,
  pageSelection,
}: {
  readonly labels: {
    readonly pageSelectionBox: string;
    readonly pageSelectionPointer: string;
    readonly pageSelectionTools: string;
  };
  readonly pageSelection: MermaidPageSelectionProjection;
}) {
  const buttonRefs = useRef<
    Partial<Record<"box" | "pointer", HTMLButtonElement | null>>
  >({});
  const tools = [
    {
      icon: <SelectIcon />,
      label: labels.pageSelectionPointer,
      tool: "pointer" as const,
    },
    {
      icon: <SelectAreaIcon />,
      label: labels.pageSelectionBox,
      tool: "box" as const,
    },
  ] as const;

  return (
    <Group gap="xs" data-myoxus-ui-role="mermaid-page-selection-tools">
      <IconButtonGroup aria-label={labels.pageSelectionTools} role="radiogroup">
        {tools.map(({ icon, label, tool }, index) => {
          const checked = pageSelection.state.tool === tool;
          return (
            <IconButton
              aria-checked={checked}
              aria-label={label}
              icon={icon}
              key={tool}
              onClick={() => pageSelection.onToolChange(tool)}
              onKeyDown={(event) => {
                const direction =
                  event.key === "ArrowLeft" || event.key === "ArrowUp"
                    ? -1
                    : event.key === "ArrowRight" || event.key === "ArrowDown"
                      ? 1
                      : 0;
                if (!direction) return;
                event.preventDefault();
                event.stopPropagation();
                const next =
                  tools[(index + direction + tools.length) % tools.length];
                pageSelection.onToolChange(next.tool);
                buttonRefs.current[next.tool]?.focus();
              }}
              ref={(element) => {
                buttonRefs.current[tool] = element;
              }}
              role="radio"
              tabIndex={checked ? 0 : -1}
              tooltip={label}
              variant={checked ? "solid" : "plain"}
            />
          );
        })}
      </IconButtonGroup>
    </Group>
  );
}

export function MermaidBlockShell({
  props,
}: {
  readonly props: MermaidBlockShellReactHostProps;
}) {
  const t = useI18n();
  const readingSnapshot = useContext(ReadingSnapshotContext) && props.readonly;
  const { onSelectionActionInvokerChange, showPageActions } = props;
  const shellRef = useRef<HTMLElement | null>(null);
  const familyActionPortal = props.actions?.portal ? props.actions : null;
  const renderedFamilyActions = props.actions?.portal ? null : props.actions;
  const selectionAction = props.actions?.selectionAction ?? null;
  const pageSelectionAction =
    props.mode === "visual" && !props.readonly ? selectionAction : null;
  return (
    <Card
      aria-label={props.labels.ariaBlock}
      component="section"
      data-display-mode={
        readingSnapshot || props.mode === "view" ? "display" : "edit"
      }
      data-editor-surface={
        props.sourceFirst ? "source-first" : "visual-capable"
      }
      data-source-state={props.sourceState}
      data-stale-projection={props.staleProjection || undefined}
      data-myoxus-ui-role="mermaid-block-shell"
      data-selected={props.focused || undefined}
      onClick={(event) => props.onSelect(event.nativeEvent)}
      onKeyDown={(event) => props.onBlockKeydown(event.nativeEvent)}
      role="group"
      ref={shellRef}
      tabIndex={0}
      withBorder
    >
      <Stack gap={0}>
        <MermaidEditorShellHeader
          props={props}
          readingSnapshot={readingSnapshot}
        />
        {props.showPageActions && !readingSnapshot ? (
          <Scrollable.Viewport
            autosize
            scrollbars="x"
            scrollbarVisibility="auto"
            aria-label={props.labels.controls}
          >
            <Group
              aria-label={props.labels.controls}
              data-myoxus-ui-role="mermaid-page-action-row"
              justify="flex-start"
              gap="xs"
              p="sm"
              role="toolbar"
              wrap="nowrap"
            >
              {props.mode === "view" || props.readonly ? null : (
                <IconButtonGroup
                  aria-label={`${t["Undo"]()} / ${t["com.myoxus.editor.keyboard.redo"]()}`}
                  data-myoxus-ui-role="mermaid-history-actions"
                >
                  <IconButton
                    aria-label={t["Undo"]()}
                    disabled={props.readonly || !props.canUndo}
                    icon={<UndoIcon />}
                    onClick={props.onUndo}
                    tooltip={`${t["Undo"]()} (Mod-Z)`}
                  />
                  <IconButton
                    aria-label={t["com.myoxus.editor.keyboard.redo"]()}
                    disabled={props.readonly || !props.canRedo}
                    icon={<RedoIcon />}
                    onClick={props.onRedo}
                    tooltip={`${t["com.myoxus.editor.keyboard.redo"]()} (Shift-Mod-Z / Mod-Y)`}
                  />
                </IconButtonGroup>
              )}
              {props.mode === "visual" && !props.readonly ? (
                <IconButtonGroup
                  aria-label={selectionAction?.label ?? t["Delete"]()}
                  data-myoxus-ui-role="mermaid-selection-actions"
                >
                  <MermaidSelectionDeleteAction
                    action={pageSelectionAction}
                    onInvokerChange={
                      showPageActions
                        ? onSelectionActionInvokerChange
                        : undefined
                    }
                  />
                </IconButtonGroup>
              ) : null}
              {props.mode === "source" ? null : (
                <IconButtonGroup
                  aria-label={props.labels.pageCenter}
                  data-myoxus-ui-role="mermaid-page-viewport-actions"
                >
                  <IconButton
                    aria-label={props.labels.pageCenter}
                    disabled={props.pageCenterDisabled}
                    icon={<LocateIcon />}
                    onClick={props.onPageCenter}
                    tooltip={props.labels.pageCenter}
                  />
                </IconButtonGroup>
              )}
              {props.pageSelection ? (
                <MermaidPageSelectionToolControls
                  labels={props.labels}
                  pageSelection={props.pageSelection}
                />
              ) : null}
              {props.mode === "visual" && familyActionPortal ? (
                <Box
                  aria-label={familyActionPortal.actions[0]?.label}
                  data-disabled={
                    familyActionPortal.actions.every(
                      (action) => action.disabled,
                    ) || undefined
                  }
                  data-myoxus-ui-role="mermaid-family-action-target"
                  ref={props.onActionTargetChange}
                  role="group"
                />
              ) : props.mode === "visual" && renderedFamilyActions ? (
                <IconButtonGroup
                  aria-label={renderedFamilyActions.actions
                    .map((action) => action.label)
                    .join(", ")}
                  data-myoxus-ui-role="mermaid-family-actions"
                >
                  {renderedFamilyActions.actions.map((action) =>
                    action.popoverProjection ? (
                      <Box key={action.id}>
                        {toReactNode(
                          action.popoverProjection as Parameters<
                            typeof toReactNode
                          >[0],
                        )}
                      </Box>
                    ) : null,
                  )}
                </IconButtonGroup>
              ) : null}
            </Group>
          </Scrollable.Viewport>
        ) : null}
        {props.bodyNotice ? (
          <MermaidEditorShellNotice props={props.bodyNotice} />
        ) : null}
        {readingSnapshot && props.mode === "source" ? (
          props.sourcePreview ? (
            toReactNode(
              props.sourcePreview as Parameters<typeof toReactNode>[0],
            )
          ) : (
            <MyoxusText>{props.labels.previewEmpty}</MyoxusText>
          )
        ) : props.mode === "source" ? (
          <Stack
            data-myoxus-ui-role="mermaid-source-body"
            data-range-sync-exclude="true"
            gap="sm"
            p="sm"
          >
            <MermaidSourceEditor props={props} />
            {/* GFX-only families keep last-valid state in their owner
                lifecycle; Source remains the single corrective text surface
                and must not add a second visual projection beneath it. */}
            {props.usesGfxOnlyDiagram ? null : (
              <Box aria-label={props.labels.sourcePreview} role="group">
                {toReactNode(
                  props.sourcePreview as Parameters<typeof toReactNode>[0],
                )}
              </Box>
            )}
          </Stack>
        ) : props.emptyVisual && props.mode === "visual" ? (
          <Stack
            align="center"
            data-myoxus-ui-role="mermaid-empty-visual"
            gap="sm"
          >
            <MyoxusText>{props.labels.previewEmpty}</MyoxusText>
            {!readingSnapshot ? (
              <Group wrap="wrap">
                <Button
                  disabled={props.readonly}
                  onClick={props.emptyVisual.onBlankDiagram}
                  variant="secondary"
                >
                  {props.labels.emptyBlank}
                </Button>
                <Button
                  disabled={props.readonly}
                  onClick={props.emptyVisual.onImportClick}
                  variant="secondary"
                >
                  {props.labels.emptyImport}
                </Button>
                <Button
                  disabled={props.readonly}
                  onClick={props.emptyVisual.onPasteSource}
                  variant="secondary"
                >
                  {props.labels.emptyPaste}
                </Button>
                <input
                  accept=".mmd,.mermaid,text/plain,text/markdown"
                  className="myoxus-mermaid-file-input"
                  hidden
                  onChange={(event) =>
                    props.emptyVisual?.onFileImport(event.nativeEvent)
                  }
                  type="file"
                />
              </Group>
            ) : null}
          </Stack>
        ) : props.body ? (
          toReactNode(props.body as Parameters<typeof toReactNode>[0])
        ) : null}
      </Stack>
    </Card>
  );
}

export function MermaidEditorShellNotice({
  props,
}: {
  readonly props: MermaidShellNoticeReactHostProps;
}) {
  return (
    <Alert
      color={props.tone === "error" ? "myoxusError" : "myoxusWarning"}
      data-myoxus-ui-role="mermaid-editor-notice"
      role={props.tone === "error" ? "alert" : "status"}
      title={props.title}
      variant="light"
    >
      <Stack gap="xs">
        <MyoxusText>{props.message}</MyoxusText>
        {props.actions?.length ? (
          <Group wrap="wrap">
            {props.actions.map((action) => (
              <Button
                disabled={action.disabled}
                key={action.id}
                onClick={action.onSelect}
                variant="secondary"
              >
                {action.label}
              </Button>
            ))}
          </Group>
        ) : null}
      </Stack>
    </Alert>
  );
}
