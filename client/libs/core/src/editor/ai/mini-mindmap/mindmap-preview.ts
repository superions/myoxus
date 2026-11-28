// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import {
  MermaidFamilyReactHostIdentifier,
  mermaidMessages as m,
  mermaidMindmapRendererToken,
  MindmapDesign,
  type PreparedMindmapTree,
  prepareMindmapTree,
  readMermaidSourceLimit,
} from "@virgultum/block-mermaid";
import type { EditorHost } from "@virgultum/editor/std";
import { type ReactNode, useEffect, useMemo, useState } from "react";

import type { AIContext } from "../utils/context";
import { markdownToMindmap } from "./markdown";

export { markdownToMindmap } from "./markdown";

export interface MiniMindmapPreviewProps {
  answer: string;
  ctx?: AIContext;
  height?: number;
  host: EditorHost;
  mindmapStyle?: MindmapDesign;
  templateShow?: boolean;
}

type PreviewResolution = {
  candidate: PreparedMindmapTree | null;
  node: ReturnType<typeof markdownToMindmap> | null;
  error: string | null;
};

/**
 * Renders a read-only candidate mindmap preview inside the AI answer panel.
 * Confirmed canvas mutations happen only when the user accepts an insert action.
 */
export function MiniMindmapPreview({
  answer,
  ctx,
  height = 400,
  host,
  mindmapStyle,
  templateShow = true,
}: MiniMindmapPreviewProps): ReactNode {
  const [sourceLimit, setSourceLimit] = useState<number | null>(null);
  const [limitError, setLimitError] = useState<string | null>(null);
  const [design, setDesign] = useState<MindmapDesign>(
    mindmapStyle ?? MindmapDesign.FOUR,
  );

  useEffect(() => {
    if (mindmapStyle !== undefined) {
      setDesign(mindmapStyle);
    }
  }, [mindmapStyle]);

  useEffect(() => {
    let mounted = true;
    readMermaidSourceLimit()
      .then((limit) => {
        if (!mounted) return;
        setSourceLimit(limit);
        setLimitError(null);
      })
      .catch(() => {
        if (!mounted) return;
        setLimitError(m.errorTitle());
      });
    return () => {
      mounted = false;
    };
  }, []);

  const resolution = useMemo<PreviewResolution>(() => {
    if (limitError) {
      return { candidate: null, node: null, error: limitError };
    }
    if (!host || sourceLimit === null) {
      return { candidate: null, node: null, error: null };
    }
    try {
      if (answer.length > sourceLimit) {
        throw new Error("mindmap-source-limit-exceeded");
      }
      const parsed = markdownToMindmap(
        answer,
        host.store,
        host.std.store.provider,
      );
      if (!parsed) {
        throw new Error("mindmap-tree-invalid");
      }
      return {
        candidate: prepareMindmapTree(parsed, sourceLimit, design),
        node: parsed,
        error: null,
      };
    } catch {
      return {
        candidate: null,
        node: null,
        error: m.visualMutationSourceRejected("mindmap"),
      };
    }
  }, [answer, design, host, limitError, sourceLimit]);

  useEffect(() => {
    if (!ctx || sourceLimit === null) return;
    if (resolution.node && !resolution.error) {
      ctx.set({ node: resolution.node, style: design });
    } else if (resolution.error) {
      ctx.set({ node: null });
    }
  }, [ctx, design, resolution.error, resolution.node, sourceLimit]);

  const mermaidHost = host?.std.getOptional(MermaidFamilyReactHostIdentifier);
  if (!mermaidHost) return null;

  if (resolution.error) {
    return mermaidHost.renderShellNotice({
      title: m.errorTitle(),
      message: resolution.error,
      tone: "error",
    });
  }

  if (!resolution.candidate) {
    return m.loading();
  }

  return mermaidHost.renderFamilyEditor(mermaidMindmapRendererToken, {
    surface: "preview",
    host,
    model: resolution.candidate.model,
    design,
    height,
    showDesigns: templateShow,
    onDesignChange: setDesign,
  });
}
