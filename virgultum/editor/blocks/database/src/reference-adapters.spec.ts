// SPDX-License-Identifier: AGPL-3.0-or-later

import { Container } from "@virgultum/global/di";
import {
  BlockHtmlAdapterMatcherIdentifier,
  BlockMarkdownAdapterMatcherIdentifier,
  BlockPlainTextAdapterMatcherIdentifier,
} from "@virgultum/shared/adapters";
import type { BlockSnapshot } from "@virgultum/store";
import { expect, test, vi } from "vitest";

import { DatabaseReferenceAdapterExtensions } from "./reference-adapters";

test.each(["task", "null"])(
  "%s contextual references export opaque content without private identities or cached values",
  async (kind) => {
    const container = new Container();
    for (const extension of DatabaseReferenceAdapterExtensions)
      extension.setup(container);
    const provider = container.provider();
    const workspaceId = "00000000-0000-4000-8000-000000000001";
    const node: BlockSnapshot = {
      type: "block",
      id: "reference",
      flavour: "myoxus:database",
      children: [],
      props: {
        serverReferencePresentation:
          kind === "malformed" ? "invalid" : kind === "null" ? null : "compact",
        ...(kind === "unbound"
          ? {
              templateReference: {
                key: "context.container",
                kind: "database",
                optional: true,
              },
            }
          : {
              serverWorkspaceId: workspaceId,
              serverDatabaseId: "00000000-0000-4000-8000-000000000002",
              ...(["task", "malformed", "null"].includes(kind)
                ? { serverRowId: "00000000-0000-4000-8000-000000000003" }
                : {}),
            }),
        title: "Private cached title",
        cells: { secret: "Private cached Cell" },
      },
    };
    for (const matcher of [
      provider.get(BlockMarkdownAdapterMatcherIdentifier("myoxus:database")),
      provider.get(BlockHtmlAdapterMatcherIdentifier("myoxus:database")),
      provider.get(BlockPlainTextAdapterMatcherIdentifier("myoxus:database")),
    ]) {
      const input = { node, parent: null, prop: null, index: null };
      expect(matcher.fromMatch(input)).toBe(true);
      const emitted: unknown[] = [];
      const skipAllChildren = vi.fn();
      const walkerContext = {
        openNode(value: unknown) {
          emitted.push(value);
          return walkerContext;
        },
        closeNode() {
          return walkerContext;
        },
        skipAllChildren,
      };
      const context = {
        walkerContext,
        configs: new Map([
          ["docLinkBaseUrl", `https://myoxus.test/workspace/${workspaceId}`],
        ]),
        textBuffer: { content: "" },
      };
      await matcher.fromBlockSnapshot.enter!(input, context as never);
      const output = JSON.stringify([emitted, context.textBuffer.content]);
      expect(output).not.toContain("00000000-");
      expect(output).not.toContain("Private cached");
      expect(output).not.toContain("https://");
      expect(output).not.toContain("templateReference");
      expect(emitted.length > 0 || context.textBuffer.content.length > 0).toBe(
        true,
      );
      expect(skipAllChildren).toHaveBeenCalledOnce();
    }
  },
);
