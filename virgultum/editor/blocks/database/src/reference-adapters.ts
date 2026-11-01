// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  BlockHtmlAdapterExtension,
  BlockMarkdownAdapterExtension,
  BlockPlainTextAdapterExtension,
  type BlockHtmlAdapterMatcher,
  type BlockMarkdownAdapterMatcher,
  type BlockPlainTextAdapterMatcher,
} from "@virgultum/shared/adapters";
import {
  editorMessage,
  EditorI18nProvider,
  resolveEditorMessage,
} from "@virgultum/shared/services";
import type { BlockSnapshot } from "@virgultum/store";
import type { ServiceProvider } from "@virgultum/global/di";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fromMatch: BlockMarkdownAdapterMatcher["fromMatch"] = ({ node }) =>
  node.flavour === "myoxus:database" &&
  (node.props.serverRowId !== undefined ||
    node.props.serverReferencePresentation !== undefined ||
    node.props.templateReference !== undefined);

/** The existing export producer binds docLinkBaseUrl to the containing workspace.
 * A static reference never loads SQL data or trusts cached display props. The
 * ordinary authenticated link grants no Task access to a document-only reader.
 */
function taskLink(props: BlockSnapshot["props"], configs: Map<string, string>) {
  // Contextual template references stay opaque outside the authenticated editor.
  if (
    props.serverReferencePresentation !== undefined ||
    props.templateReference !== undefined
  )
    return null;
  const { serverWorkspaceId, serverDatabaseId, serverRowId, serverViewId } =
    props;
  if (
    ![serverWorkspaceId, serverDatabaseId, serverRowId].every(
      (value) => typeof value === "string" && uuid.test(value),
    ) ||
    (serverViewId !== undefined && serverViewId !== null)
  )
    return null;
  const base = configs.get("docLinkBaseUrl");
  if (!base) return null;
  try {
    const url = new URL(base);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname.replace(/\/$/, "") !== `/workspace/${serverWorkspaceId}`
    )
      return null;
    url.pathname = `/workspace/${serverWorkspaceId}/databases/${serverDatabaseId}`;
    url.searchParams.set("rowId", String(serverRowId));
    return url.toString();
  } catch {
    return null;
  }
}
function label(available: boolean, provider?: ServiceProvider) {
  return resolveEditorMessage(
    available
      ? editorMessage("com.myoxus.journal.template.col.task", "Task")
      : editorMessage(
          "com.myoxus.reference.target-unavailable",
          "Target unavailable",
        ),
    provider?.getOptional(EditorI18nProvider) ?? undefined,
  );
}

const markdown: BlockMarkdownAdapterMatcher = {
  flavour: "myoxus:database",
  fromMatch,
  toMatch: () => false,
  toBlockSnapshot: {},
  fromBlockSnapshot: {
    enter: ({ node }, context) => {
      const url = taskLink(node.props, context.configs);
      const text = {
        type: "text" as const,
        value: label(Boolean(url), context.scopeProvider),
      };
      context.walkerContext
        .openNode(
          {
            type: "paragraph",
            children: url ? [{ type: "link", url, children: [text] }] : [text],
          },
          "children",
        )
        .closeNode();
      context.walkerContext.skipAllChildren();
    },
  },
};
const html: BlockHtmlAdapterMatcher = {
  flavour: "myoxus:database",
  fromMatch,
  toMatch: () => false,
  toBlockSnapshot: {},
  fromBlockSnapshot: {
    enter: ({ node }, context) => {
      const url = taskLink(node.props, context.configs);
      const text = {
        type: "text" as const,
        value: label(Boolean(url), context.scopeProvider),
      };
      context.walkerContext
        .openNode(
          {
            type: "element",
            tagName: "p",
            properties: {},
            children: url
              ? [
                  {
                    type: "element",
                    tagName: "a",
                    properties: { href: url },
                    children: [text],
                  },
                ]
              : [text],
          },
          "children",
        )
        .closeNode();
      context.walkerContext.skipAllChildren();
    },
  },
};
const plainText: BlockPlainTextAdapterMatcher = {
  flavour: "myoxus:database",
  fromMatch,
  toMatch: () => false,
  toBlockSnapshot: {},
  fromBlockSnapshot: {
    enter: ({ node }, context) => {
      const url = taskLink(node.props, context.configs);
      const text = label(Boolean(url), context.scopeProvider);
      context.textBuffer.content += url ? `[${text}](${url})\n` : `${text}\n`;
      context.walkerContext.skipAllChildren();
    },
  },
};

export const DatabaseReferenceAdapterExtensions = [
  BlockMarkdownAdapterExtension(markdown),
  BlockHtmlAdapterExtension(html),
  BlockPlainTextAdapterExtension(plainText),
];
