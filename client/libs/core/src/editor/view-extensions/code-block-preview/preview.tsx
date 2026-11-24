// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useI18n } from "@myoxus/i18n";
import {
  ExternalLinkIcon,
  ResetIcon,
  ZoomDownIcon,
  ZoomUpIcon,
} from "@myoxus/icons/react";
import {
  IconButton,
  IconButtonGroup,
  MyoxusText,
  Paper,
} from "@myoxus/ui-facade";
import {
  MermaidRenderSourceError,
  renderMermaidSvg,
} from "@virgultum/block-mermaid/renderer";
import type { EditorCodePreviewControls } from "@virgultum/editor/shared/services";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { HtmlCodePreview } from "./html-preview";
import { CodePreviewStatus } from "./status-view";
import { installPreviewStyles } from "./preview-styles";
import { ensureTypstReady, getTypst } from "./typst";

type VectorLanguage = "mermaid" | "typst";
type VectorResult = { svg: string } | { detail: string };

export function EditorCodePreview({
  controls,
}: {
  controls: EditorCodePreviewControls;
}) {
  const source = useSyncExternalStore(controls.subscribe, controls.getSource);
  return (
    <CodePreview
      language={controls.language}
      source={source}
      convertMermaid={controls.convertMermaid}
    />
  );
}

export function CodePreview({
  language,
  source,
  convertMermaid,
}: Pick<EditorCodePreviewControls, "language" | "convertMermaid"> & {
  source: string;
}) {
  if (language === "html") return <HtmlCodePreview source={source} />;

  return (
    <VectorCodePreview
      key={language + source}
      language={language}
      source={source}
      convertMermaid={convertMermaid}
    />
  );
}

function VectorCodePreview({
  language,
  source,
  convertMermaid,
}: {
  language: VectorLanguage;
  source: string;
  convertMermaid?: () => void;
}) {
  const [result, setResult] = useState<VectorResult>();
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const copyTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const alive = useRef(false);
  const isMermaid = language === "mermaid";
  const label = isMermaid ? "Mermaid" : "Typst";

  useEffect(() => {
    const code = isMermaid ? source : source.trim();
    if (!code) return;
    let active = true;
    alive.current = true;
    let retries = 0;
    const render = async () => {
      try {
        let svg: string;
        if (isMermaid) {
          ({ svg } = await renderMermaidSvg(code, {
            idPrefix: "mermaid-code-preview",
          }));
        } else {
          await ensureTypstReady();
          svg = await (await getTypst()).svg({ mainContent: code });
        }
        if (active) setResult({ svg });
      } catch (error) {
        if (!active) return;
        if (
          isMermaid &&
          !(error instanceof MermaidRenderSourceError) &&
          retries < 3
        ) {
          retries++;
          timer = setTimeout(() => void render(), 1000);
          return;
        }
        const detail = error instanceof Error ? error.message : String(error);
        setResult({ detail });
      }
    };
    let timer = setTimeout(() => void render(), isMermaid ? 100 : 200);
    // Renderer promises can finish after source, mode or document changes.
    return () => {
      active = false;
      alive.current = false;
      clearTimeout(timer);
      clearTimeout(copyTimeout.current);
    };
  }, [isMermaid, source]);

  async function copyDetail(detail: string) {
    let next: "copied" | "failed";
    try {
      await navigator.clipboard.writeText(detail);
      next = "copied";
    } catch {
      next = "failed";
    }
    if (!alive.current) return;
    setCopyState(next);
    clearTimeout(copyTimeout.current);
    copyTimeout.current = setTimeout(() => setCopyState("idle"), 1500);
  }

  if (!source.trim() || (result && "svg" in result && !result.svg))
    return <CodePreviewStatus status={{ language: label, state: "empty" }} />;
  if (!result)
    return <CodePreviewStatus status={{ language: label, state: "loading" }} />;
  if ("detail" in result)
    return (
      <CodePreviewStatus
        status={{
          language: label,
          state: "error",
          detail: result.detail,
          fontError:
            !isMermaid &&
            result.detail.toLowerCase().includes("no font could be found"),
          copyState,
          copy:
            !isMermaid && result.detail
              ? () => void copyDetail(result.detail)
              : undefined,
        }}
      />
    );
  return (
    <SvgViewport
      language={language}
      svg={result.svg}
      convertMermaid={convertMermaid}
    />
  );
}

const initialView = { x: 0, y: 0, scale: 1 };

function SvgViewport({
  language,
  svg,
  convertMermaid,
}: {
  language: VectorLanguage;
  svg: string;
  convertMermaid?: () => void;
}) {
  const t = useI18n();
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const [view, setView] = useState(initialView);
  const isMermaid = language === "mermaid";
  const minScale = isMermaid ? 0.1 : 0.2;
  const clampScale = (scale: number) => Math.max(minScale, Math.min(5, scale));

  useEffect(() => {
    const element = viewport.current;
    if (!element || !isMermaid) return;
    const zoom = (event: WheelEvent) => {
      event.preventDefault();
      // Pan uses the same coordinate space as the diagram's center origin.
      const diagram = element.firstElementChild as HTMLElement;
      const bounds = diagram.getBoundingClientRect();
      const x = event.clientX - (bounds.left + bounds.width / 2);
      const y = event.clientY - (bounds.top + bounds.height / 2);
      setView((current) => {
        const scale = Math.max(
          0.1,
          Math.min(5, current.scale * (event.deltaY > 0 ? 0.9 : 1.1)),
        );
        const delta = 1 - scale / current.scale;
        return { x: current.x + x * delta, y: current.y + y * delta, scale };
      });
    };
    element.addEventListener("wheel", zoom, { passive: false });
    return () => element.removeEventListener("wheel", zoom);
  }, [isMermaid]);

  const step = (ratio: number) =>
    setView((current) => ({
      ...current,
      scale: clampScale(current.scale * ratio),
    }));
  const zoomIn = (
    <IconButton
      icon={<ZoomUpIcon />}
      tooltip={t["Zoom in"]()}
      onClick={() => step(1.2)}
    />
  );
  const zoomOut = (
    <IconButton
      icon={<ZoomDownIcon />}
      tooltip={t["Zoom out"]()}
      onClick={() => step(1 / 1.2)}
    />
  );
  const reset = (
    <IconButton
      icon={<ResetIcon />}
      tooltip="Reset view"
      onClick={() => setView(initialView)}
    />
  );

  return (
    <Paper
      ref={installPreviewStyles}
      withBorder
      className={`editor-vector-preview editor-vector-preview--${language}`}
      data-range-sync-exclude="true"
    >
      <div
        ref={viewport}
        className="editor-vector-viewport"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          drag.current = {
            x: event.clientX,
            y: event.clientY,
            pointerId: event.pointerId,
          };
        }}
        onPointerMove={(event) => {
          if (drag.current?.pointerId !== event.pointerId) return;
          const dx = event.clientX - drag.current.x;
          const dy = event.clientY - drag.current.y;
          if (!dx && !dy) return;
          if (!event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = {
            x: event.clientX,
            y: event.clientY,
            pointerId: event.pointerId,
          };
          setView((current) => ({
            ...current,
            x: current.x + dx,
            y: current.y + dy,
          }));
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onPointerLeave={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId))
            drag.current = null;
        }}
        onLostPointerCapture={() => {
          drag.current = null;
        }}
      >
        <div
          className={`${language}-preview-svg editor-vector-svg`}
          style={{
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
          }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
      <IconButtonGroup className="editor-vector-controls">
        {isMermaid ? (
          <>
            {convertMermaid && (
              <IconButton
                icon={<ExternalLinkIcon />}
                tooltip="Convert to Mermaid block"
                onClick={convertMermaid}
              />
            )}
            {zoomIn}
            {zoomOut}
            {reset}
          </>
        ) : (
          <>
            {zoomOut}
            {reset}
            {zoomIn}
          </>
        )}
      </IconButtonGroup>
      {isMermaid && (
        <MyoxusText
          className="editor-vector-scale"
          tone="secondary"
          typographySlot="caption"
        >
          {Math.round(view.scale * 100)}%
        </MyoxusText>
      )}
    </Paper>
  );
}
