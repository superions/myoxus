// SPDX-License-Identifier: MIT
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
import { markdownToMindmap } from "./markdown.js";
export { markdownToMindmap } from "./markdown.js";

export interface MiniMindmapPreviewProps {
  answer: string;
  ctx?: AIContext;
  height?: number;
  host: EditorHost;
  mindmapStyle?: MindmapDesign;
  templateShow?: boolean;
}

/** AI state remains a local candidate. Confirmed document writes belong to the
 * existing response/insert consumers, never to rendering or streaming. */
export function MiniMindmapPreview({
  answer,
  ctx,
  height = 400,
  host,
  mindmapStyle,
  templateShow = true,
}: MiniMindmapPreviewProps): ReactNode {
  const [limit, setLimit] = useState<number | null>(null);
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
    let active = true;
    readMermaidSourceLimit()
      .then((resolved) => {
        if (active) {
          setLimit(resolved);
          setLimitError(null);
        }
      })
      .catch(() => {
        if (active) {
          setLimitError(m.errorTitle());
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const computed = useMemo<{
    candidate: PreparedMindmapTree | null;
    node: ReturnType<typeof markdownToMindmap> | null;
    error: string | null;
  }>(() => {
    if (limitError) {
      return { candidate: null, node: null, error: limitError };
    }
    if (!host || limit === null) {
      return { candidate: null, node: null, error: null };
    }
    try {
      if (answer.length > limit) throw new Error("source-limit");
      const node = markdownToMindmap(
        answer,
        host.store,
        host.std.store.provider,
      );
      if (!node) throw new Error("mindmap-tree");
      return {
        candidate: prepareMindmapTree(node, limit, design),
        node,
        error: null,
      };
    } catch {
      return {
        candidate: null,
        node: null,
        error: m.visualMutationSourceRejected("mindmap"),
      };
    }
  }, [answer, design, host, limit, limitError]);

  useEffect(() => {
    if (!ctx || limit === null) return;
    if (computed.node && !computed.error) {
      ctx.set({ node: computed.node, style: design });
    } else if (computed.error) {
      ctx.set({ node: null });
    }
  }, [computed.error, computed.node, ctx, design, limit]);

  const mermaidHost = host?.std.getOptional(MermaidFamilyReactHostIdentifier);
  if (!mermaidHost) return null;

  if (computed.error) {
    return mermaidHost.renderShellNotice({
      title: m.errorTitle(),
      message: computed.error,
      tone: "error",
    });
  }

  if (!computed.candidate) {
    return m.loading();
  }

  return mermaidHost.renderFamilyEditor(mermaidMindmapRendererToken, {
    surface: "preview",
    host,
    model: computed.candidate.model,
    design,
    height,
    showDesigns: templateShow,
    onDesignChange: setDesign,
  });
}
