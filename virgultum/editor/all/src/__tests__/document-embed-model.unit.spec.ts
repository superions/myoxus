// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  documentReferenceMiddleware,
  MarkdownAdapter,
  HtmlAdapter,
  MixTextAdapter,
  docLinkBaseURLMiddleware,
  docLinkBaseURLMiddlewareBuilder,
} from "@virgultum/core/adapters";
import type { BlockSnapshot } from "@virgultum/core/store";
import { describe, expect, test } from "vitest";
import fixtures from "../../../../../build/fixtures/contracts/document-embeds.json";
import { createJob } from "./utils/create-job";
import { getProvider } from "./utils/get-provider";

const flatten = (blocks: BlockSnapshot[]): BlockSnapshot[] =>
  blocks.flatMap((block) => [block, ...flatten(block.children)]);
const references = (blocks: BlockSnapshot[]) =>
  flatten(blocks).flatMap(
    (block) =>
      (
        block.props.text as
          { delta?: { attributes?: { reference?: unknown } }[] } | undefined
      )?.delta?.filter((part) => part.attributes?.reference) ?? [],
  );

describe("registered document embed interchange", () => {
  test("actual URL-based document export reimports its aliased live relation", async () => {
    const job = createJob([
      documentReferenceMiddleware([
        { id: "opaque-target-key", title: "Target" },
      ]),
      docLinkBaseURLMiddlewareBuilder("https://myoxus.example", "ws").get(),
    ]);
    try {
      const adapter = new MarkdownAdapter(job, getProvider());
      const source = await adapter.toBlockSnapshot({
        file: "Before **review**.\n\n![[Target|Current approval]]\n\nAfter [[Target|Open approval]].",
      });
      const exported = await adapter.fromBlockSnapshot({ snapshot: source });
      expect(exported.file).toContain(
        "![[https://myoxus.example/workspace/ws/opaque-target-key|Current approval]]",
      );
      const imported = await adapter.toBlockSnapshot({ file: exported.file });
      expect(
        flatten(imported.children)
          .filter((block) => block.flavour === "myoxus:embed-synced-doc")
          .map((block) => ({
            pageId: block.props.pageId,
            title: block.props.title,
            children: block.children,
          })),
      ).toEqual([
        {
          pageId: "opaque-target-key",
          title: "Current approval",
          children: [],
        },
      ]);
      expect(references(imported.children)).toHaveLength(1);
      expect(JSON.stringify(imported)).toContain('"bold":true');
      expect(adapter.importDiagnostics.unresolvedReferences).toBe(0);
      expect(adapter.importDiagnostics.unsupportedReferences).toBe(0);
      const literal = await adapter.toBlockSnapshot({
        file: "\\![[https://myoxus.example/workspace/ws/opaque-target-key|Escaped approval]]\n\n`![[https://myoxus.example/workspace/ws/opaque-target-key]]`\n\n%%Ask Anna about ![[https://myoxus.example/workspace/ws/opaque-target-key]] later.%%\n\nRead https://external.example/approval and www.external.example.",
      });
      expect(
        flatten(literal.children).filter(
          (block) => block.flavour === "myoxus:embed-synced-doc",
        ),
      ).toEqual([]);
      expect(JSON.stringify(literal)).toContain(
        '"link":"https://external.example/approval"',
      );
      expect(JSON.stringify(literal)).toContain(
        '"link":"http://www.external.example"',
      );
      expect(JSON.stringify(literal)).toContain(
        '"flavour":"myoxus:annotation"',
      );
    } finally {
      job[Symbol.dispose]();
    }
  });
  test.each(
    fixtures.filter(({ name }) => name !== "whole note and normal link"),
  )("$name", async (fixture) => {
    const job = createJob([
      documentReferenceMiddleware(
        [
          { id: "opaque-target-key", title: "Target" },
          { id: "duplicate-a", title: "Duplicate" },
          { id: "duplicate-b", title: "Duplicate" },
        ],
        new Map([["Target.v2.md", "opaque-target-key"]]),
        "Source.md",
        {
          nativeTargets: new Map([
            [
              "opaque-target-key",
              [
                {
                  blockId: "heading-id",
                  headingPath: ["Heading"],
                  canExportAnchor: true,
                },
                {
                  blockId: "block-id",
                  sourceAnchor: "block",
                  canExportAnchor: true,
                },
              ],
            ],
          ]),
        },
      ),
      docLinkBaseURLMiddleware("ws"),
    ]);
    try {
      const adapter = new MarkdownAdapter(job, getProvider());
      const snapshot = await adapter.toBlockSnapshot({ file: fixture.source });
      const embeds = flatten(snapshot.children).filter(
        (block) => block.flavour === "myoxus:embed-synced-doc",
      );
      expect(embeds).toHaveLength(fixture.embeds);
      expect(references(snapshot.children)).toHaveLength(fixture.links);
      expect(adapter.importDiagnostics.unresolvedReferences).toBe(
        fixture.unresolved,
      );
      expect(adapter.importDiagnostics.unsupportedReferences).toBe(
        fixture.unsupported,
      );
      for (const embed of embeds) {
        expect(embed.props.pageId).toBe("opaque-target-key");
        expect(embed.children).toEqual([]);
        const output = await adapter.fromBlockSnapshot({ snapshot: embed });
        expect(output.file).toContain("![[");
        expect(adapter.exportDiagnostics.unresolvedReferences).toBe(0);
        const again = await adapter.toBlockSnapshot({ file: output.file });
        expect(
          flatten(again.children)
            .filter((block) => block.flavour === embed.flavour)
            .map((block) => ({
              pageId: block.props.pageId,
              title: block.props.title,
              params: block.props.params,
            })),
        ).toEqual([
          {
            pageId: embed.props.pageId,
            title: embed.props.title,
            params: embed.props.params,
          },
        ]);
        const clipboard = await new MixTextAdapter(
          job,
          getProvider(),
        ).fromSliceSnapshot({
          snapshot: {
            type: "slice",
            workspaceId: "ws",
            pageId: "source",
            content: [embed],
          },
        });
        expect(clipboard.file).toContain("![[");
        const params = embed.props.params as
          { blockIds?: string[]; blockSelection?: string } | undefined;
        if (params?.blockIds?.length) {
          const legacy = structuredClone(embed);
          delete (legacy.props.params as Record<string, unknown>)
            .blockSelection;
          const legacyOutput = await adapter.fromBlockSnapshot({
            snapshot: legacy,
          });
          const legacyAgain = await adapter.toBlockSnapshot({
            file: legacyOutput.file,
          });
          expect(
            flatten(legacyAgain.children).find(
              (block) => block.flavour === embed.flavour,
            )?.props.params,
          ).toEqual({ ...params, blockSelection: "subtree" });
          for (const admitted of [true, false]) {
            const unavailableJob = createJob([
              documentReferenceMiddleware(
                admitted ? [{ id: "opaque-target-key", title: "Target" }] : [],
                new Map(),
                undefined,
                { nativeTargets: new Map([["opaque-target-key", []]]) },
              ),
              docLinkBaseURLMiddleware("ws"),
            ]);
            try {
              const adapter = new MarkdownAdapter(
                unavailableJob,
                getProvider(),
              );
              const missing = await adapter.fromBlockSnapshot({
                snapshot: embed,
              });
              expect(missing.file).toContain(`blockIds=${params.blockIds[0]}`);
              expect(missing.file).toContain(
                `blockSelection=${params.blockSelection ?? "subtree"}`,
              );
              if (embed.props.title)
                expect(missing.file).toContain(`|${embed.props.title}]]`);
              expect(
                adapter.exportDiagnostics.unresolvedReferences,
              ).toBeGreaterThan(0);
            } finally {
              unavailableJob[Symbol.dispose]();
            }
          }
        }
        const htmlAdapter = new HtmlAdapter(job, getProvider());
        const html = await htmlAdapter.fromBlockSnapshot({ snapshot: embed });
        const rich = await htmlAdapter.toBlockSnapshot({
          file: `<p>Before <strong>review</strong>.</p>${html.file}<p>After review.</p>`,
        });
        expect(
          flatten(rich.children)
            .filter((block) => block.flavour === embed.flavour)
            .map((block) => block.props.pageId),
        ).toEqual([embed.props.pageId]);
        expect(JSON.stringify(rich)).toContain("Before ");
        expect(JSON.stringify(rich)).toContain("After review.");
        expect(JSON.stringify(rich)).toContain('"bold":true');
      }
    } finally {
      job[Symbol.dispose]();
    }
  });
});
