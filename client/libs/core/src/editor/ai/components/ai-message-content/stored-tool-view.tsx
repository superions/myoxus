// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { PeekViewService } from "@myoxus/core/modules/peek-view";
import {
  AiEmbeddingIcon,
  CodeBlockIcon,
  PageIcon,
  PenIcon,
  SearchIcon,
  ViewIcon,
  WebIcon,
} from "@myoxus/icons/react";
import {
  NotificationProvider,
  type NotificationService,
} from "@virgultum/core/services";
import type { EditorHost } from "@virgultum/editor/std";
import type { ReactNode } from "react";

import type { DocDisplayConfig } from "../ai-chat-chips";
import type { StreamObject } from "../ai-chat-messages";
import { ArtifactCardView } from "../ai-tools/artifact-view";
import { renderNativeMcpTool } from "../ai-tools/native-mcp-tools";
import {
  StoredDocumentEdit,
  StoredSectionEdit,
} from "../ai-tools/stored-edit-results";
import {
  toolCallCard,
  toolFailedCard,
  toolResultCard,
} from "../ai-tools/tool-cards";

type Tool = Extract<StreamObject, { type: "tool-call" | "tool-result" }>;
type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function webpage(data: Tool, result: unknown) {
  const search = data.toolName === "web_search_exa";
  const icon = <WebIcon />;
  if (data.type === "tool-call")
    return toolCallCard({
      icon,
      name: search
        ? `Searching the web for "${text(data.args.query)}"`
        : `Reading the website "${text(data.args.url)}"`,
    });
  if (!Array.isArray(result) || (!search && !result.length))
    return toolFailedCard({
      icon,
      name: search ? "Web search failed" : "Web reading failed",
    });
  const sources = (search ? result : result.slice(0, 1)).map(record);
  return toolResultCard({
    icon,
    name: search
      ? "The search is complete, and these webpages have been searched"
      : "The reading is complete, and this webpage has been read",
    footerIcons: sources.map((row) => text(row.favicon)).filter(Boolean),
    results: sources.map((row) => ({
      title: text(row.title),
      content: text(row.content),
      icon: text(row.favicon) || (search ? icon : undefined),
      href: search ? text(row.url) : undefined,
    })),
  });
}

function documentWrite(
  data: Tool,
  result: RecordValue,
  docDisplay: DocDisplayConfig | undefined,
  open: ((id: string) => void) | undefined,
) {
  const id = text(result.docId) || text(data.args.doc_id);
  const title =
    (data.toolName !== "doc_update" && text(data.args.title)) ||
    (id && docDisplay?.getTitle(id));
  const create = data.toolName === "doc_create";
  const rename = data.toolName === "doc_update_meta";
  const icon = create ? <PageIcon /> : <PenIcon />;
  if (data.type === "tool-call") {
    const verb = create ? "Creating" : rename ? "Renaming to" : "Updating";
    const name = title
      ? `${verb} "${title}"`
      : create
        ? "Creating document"
        : rename
          ? "Updating document title"
          : "Updating document";
    return toolCallCard({ icon, name });
  }
  if (!data.result || result.type === "error")
    return toolFailedCard({
      icon,
      name: text(result.name) || "Document action failed",
    });
  const name = title || "Document";
  return toolResultCard({
    icon,
    name: `${create ? "Created" : rename ? "Renamed" : "Updated"} "${name}"`,
    results: [
      {
        title: name,
        icon: <PageIcon />,
        content: [text(result.message), id && `Doc ID: ${id}`]
          .filter(Boolean)
          .join("\n"),
        onClick: open && id ? () => open(id) : undefined,
      },
    ],
  });
}

import type { PageAiBridge } from "../../../virgultum/doc-editor/page-ai-bridge";

/** Render the serialized result. Only explicit editor actions may write or contact a provider. */
export function StoredToolView({
  data,
  host,
  pageBridge,
  readOnly,
  generating,
  docDisplayService,
  peekViewService,
  renderRichText,
  independentMode,
  onOpenDoc,
  notificationService,
}: {
  data: Tool;
  host?: EditorHost | null;
  pageBridge?: PageAiBridge | null;
  independentMode?: boolean;
  onOpenDoc?: (docId: string) => void;
  notificationService?: NotificationService;
  readOnly?: boolean;
  generating?: boolean;
  docDisplayService?: DocDisplayConfig;
  peekViewService?: PeekViewService;
  renderRichText: (text: string) => ReactNode;
}) {
  const open = peekViewService
    ? (docId: string) => {
        void peekViewService.peekView
          .open({ type: "doc", docRef: { docId } })
          .catch(console.error);
      }
    : undefined;
  const notifications =
    notificationService ?? host?.std.get(NotificationProvider);
  const raw: unknown = data.type === "tool-result" ? data.result : undefined;
  const result = record(raw);
  const query = text(data.args.query);
  switch (data.toolName) {
    case "read_doc":
    case "search_docs":
    case "workspace_get":
      return renderNativeMcpTool(data, {
        openDocument: open,
        getDocumentTitle: (id) => docDisplayService?.getTitle(id),
        generating: !!generating,
        contained: !independentMode,
      });
    case "web_crawl_exa":
    case "web_search_exa":
      return webpage(data, raw);
    case "doc_create":
    case "doc_update":
    case "doc_update_meta":
      return documentWrite(data, result, docDisplayService, open ?? onOpenDoc);
    case "doc_read": {
      const icon = <ViewIcon />;
      if (data.type === "tool-call")
        return toolCallCard({ icon, name: "Reading document" });
      const title = text(result.title),
        id = text(result.docId);
      return toolResultCard({
        icon,
        name: `Read "${title}"`,
        results: [
          {
            title,
            icon: <PageIcon />,
            content: text(result.markdown),
            onClick: id && open ? () => open(id) : undefined,
          },
        ],
      });
    }
    case "doc_semantic_search":
    case "doc_keyword_search": {
      const semantic = data.toolName === "doc_semantic_search";
      const icon = semantic ? <AiEmbeddingIcon /> : <SearchIcon />;
      if (data.type === "tool-call")
        return toolCallCard({
          icon,
          name: semantic
            ? `Finding semantically related pages for "${query}"`
            : `Searching workspace documents for "${query}"`,
        });
      const results = (Array.isArray(raw) ? raw : []).map(record).map((row) => {
        const id = text(row.docId);
        const body = text(row.content).replace(
          /^(?:(?:Title|Created at|Updated at|Created by|Updated by):[^\n]*\n)*/,
          "",
        );
        return {
          title: semantic
            ? docDisplayService?.getTitle(id) ||
              text(row.content).match(/^Title:\s*([^\n]+)/)?.[1] ||
              id
            : text(row.title),
          icon: <PageIcon />,
          content: semantic ? body : undefined,
          onClick: id && open ? () => open(id) : undefined,
        };
      });
      return toolResultCard({
        icon,
        name: semantic
          ? `Found semantically related pages for "${query}"`
          : `Found ${results.length} pages for "${query}"`,
        results,
      });
    }
    case "doc_compose":
    case "code_artifact": {
      const code = data.toolName === "code_artifact";
      if (result.type === "error")
        return toolFailedCard({
          name: code ? "Code artifact failed" : "Doc compose failed",
        });
      // The artifact preview panel belongs to the workspace conversation. Stored
      // block and Peek cards have no panel slot and retain their passive summary.
      return (
        <ArtifactCardView
          title={text(data.args.title)}
          icon={code ? <CodeBlockIcon /> : <PageIcon />}
          loading={data.type === "tool-call"}
        />
      );
    }
    case "section_edit":
      if (data.type === "tool-call")
        return toolCallCard({
          name: `Editing: ${text(data.args.instructions)}`,
          icon: <PageIcon />,
        });
      if (typeof result.content !== "string")
        return toolFailedCard({
          name: "Section edit failed",
          icon: <PageIcon />,
        });
      return (
        <StoredSectionEdit
          host={host}
          pageBridge={pageBridge}
          notificationService={notifications}
          readOnly={independentMode || readOnly}
          content={result.content}
          renderRichText={renderRichText}
        />
      );
    case "doc_edit":
      if (data.type === "tool-call")
        return toolCallCard({
          name: "Editing the document",
          icon: <PenIcon />,
        });
      if (!Array.isArray(result.result))
        return toolFailedCard({
          name: "Document editing failed",
          icon: <PenIcon />,
        });
      return (
        <StoredDocumentEdit
          notificationService={notifications}
          host={host}
          pageBridge={pageBridge}
          readOnly={readOnly}
          docId={text(data.args.doc_id)}
          instruction={text(data.args.instructions)}
          changes={result.result}
          renderRichText={renderRichText}
        />
      );
    default:
      return data.type === "tool-call"
        ? toolCallCard({ name: `${data.toolName} tool calling` })
        : toolResultCard({ name: `${data.toolName} tool result` });
  }
}
