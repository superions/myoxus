// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { PageIcon, SearchIcon, ViewIcon } from "@myoxus/icons/react";
import type { ReactToLit } from "@myoxus/lit-react";
import { createElement } from "react";
import { chatI18n } from "../chat-i18n";
import {
  renderToolCallCard,
  renderToolFailedCard,
  renderToolResultCard,
  type ToolResult,
} from "./tool-cards";

const labels = {
  read_doc: "com.myoxus.ai.tools.read-document",
  search_docs: "com.myoxus.ai.tools.search-documents",
  workspace_get: "com.myoxus.ai.tools.read-workspace",
} as const;
type NativeTool = keyof typeof labels;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** MCP uses external document keys; internal UUIDs must never become navigation targets. */
export function renderNativeMcpTool(
  host: ReactToLit | undefined,
  data: {
    type: "tool-call" | "tool-result";
    toolName: string;
    result?: unknown;
    args?: unknown;
  },
  {
    openDocument,
    getDocumentTitle,
    generating,
    contained,
  }: {
    openDocument?: (id: string) => void;
    getDocumentTitle: (id: string) => string | undefined;
    generating: boolean;
    contained?: boolean;
  },
) {
  const tool = data.toolName as NativeTool;
  const name = chatI18n()[labels[tool]]();
  const icon = createElement(tool === "search_docs" ? SearchIcon : ViewIcon);
  const failed = () =>
    renderToolFailedCard(host, {
      name: chatI18n()["com.myoxus.ai.tools.failed"]({ tool: name }),
      icon,
      contained,
    });
  if (data.type === "tool-call")
    return generating
      ? renderToolCallCard(host, { name, icon, contained })
      : failed();
  const value = record(data.result);
  if (value.type === "error") return failed();
  const source = (value: unknown, externalId?: string): ToolResult => {
    const item = record(value);
    const id = text(item.externalId) ?? externalId;
    const title = text(item.title) ?? (id ? getDocumentTitle(id) : undefined);
    return {
      title: title && title !== id ? title : name,
      icon: createElement(PageIcon),
      content: text(item.snippet),
      onClick: id && openDocument ? () => openDocument(id) : undefined,
    };
  };
  const results =
    tool === "search_docs"
      ? Array.isArray(value.results)
        ? value.results.map((item) => source(item))
        : []
      : tool === "read_doc"
        ? [source(value.document ?? value, text(record(data.args).external_id))]
        : [
            {
              title: text(value.name) ?? name,
              content: text(value.description),
            },
          ];
  return renderToolResultCard(host, { name, icon, results, contained });
}
