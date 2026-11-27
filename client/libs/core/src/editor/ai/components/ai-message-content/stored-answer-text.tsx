// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useI18n } from "@myoxus/i18n";
import { CodeIcon, CopyIcon, DoneIcon } from "@myoxus/icons/react";
import {
  Alert,
  Button,
  CodeHighlight,
  CodeHighlightAdapterProvider,
  CopyButton,
  createShikiAdapter,
  Group,
  MediaPreviewImage,
  MyoxusText,
  MyoxusTitle,
  Paper,
  Typography,
} from "@myoxus/ui-facade";
import {
  editorBackgroundColors,
  ParseDocUrlProvider,
} from "@virgultum/core/services";
import { PeekViewProvider } from "@virgultum/editor/components/peek";
import type { EditorHost } from "@virgultum/editor/std";
import { useMyoxusTheme } from "@myoxus/ui-facade/provider";
import { buildImageProxyURL, MarkdownAdapter } from "@virgultum/core/adapters";
import { calloutPresentation } from "@virgultum/core/models";
import { myoxusTextStyles } from "@virgultum/core/styles/text";
import {
  bundledLanguagesInfo,
  type BundledLanguageInfo,
} from "@virgultum/content/syntax-highlighter";
import { AnnotationReactHostIdentifier } from "@virgultum/editor/blocks/annotation";
import { AnnotationInline } from "../../../view-extensions/editor-view/annotation";
import { CalloutTitle } from "../../../view-extensions/editor-view/callout";
import { CitationMarker } from "../../../virgultum/doc-editor/page-citation";
import { useState, useEffect, useMemo, useRef } from "react";
import {
  MarkdownPreview,
  type MarkdownPreviewPresentation,
} from "../../../attachment-viewer/text/markdown-preview";

function resolveBundledLanguage(
  language?: string | null,
): BundledLanguageInfo | undefined {
  const normalized = language?.trim().toLowerCase();
  if (!normalized) return undefined;
  return bundledLanguagesInfo.find(
    (entry) =>
      entry.id === normalized ||
      entry.name.toLowerCase() === normalized ||
      entry.aliases?.includes(normalized),
  );
}

let aiShikiCorePromise: Promise<unknown> | null = null;

const aiShikiAdapter = createShikiAdapter(
  async () => {
    if (!aiShikiCorePromise) {
      aiShikiCorePromise = import("@virgultum/content/syntax-highlighter")
        .then(
          ({
            CODE_BLOCK_DEFAULT_DARK_THEME,
            CODE_BLOCK_DEFAULT_LIGHT_THEME,
            createEditorHighlighterCore,
          }) =>
            createEditorHighlighterCore({
              themes: [
                CODE_BLOCK_DEFAULT_DARK_THEME,
                CODE_BLOCK_DEFAULT_LIGHT_THEME,
              ],
              langs: [],
            }),
        )
        .catch((error) => {
          aiShikiCorePromise = null;
          throw error;
        });
    }
    return aiShikiCorePromise;
  },
  {
    resolveLanguage: (language) => resolveBundledLanguage(language)?.import,
  },
);

function Equation({ source, display }: { source: string; display: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const node = ref.current;
    let active = true;
    if (node) {
      node.textContent = source;
      void Promise.all([import("katex"), import("katex/dist/katex.min.css")])
        .then(([{ default: katex }]) => {
          if (active)
            katex.render(source, node, {
              displayMode: display,
              throwOnError: false,
            });
        })
        .catch(console.error);
    }
    return () => {
      active = false;
    };
  }, [source, display]);
  return <span ref={ref} />;
}

export function HighlightedCode({
  source,
  language,
  showLineNumbers = false,
}: {
  source: string;
  language?: string | null;
  showLineNumbers?: boolean;
}) {
  const t = useI18n();
  const { resolvedTheme } = useMyoxusTheme();
  const displayLanguage = language?.trim() || undefined;
  const matchedLanguage = resolveBundledLanguage(displayLanguage);
  const resolvedLanguage =
    matchedLanguage?.id ?? displayLanguage?.toLowerCase() ?? "plaintext";
  const headerLanguage = matchedLanguage?.name ?? displayLanguage ?? t.Text();

  return (
    <CodeHighlightAdapterProvider adapter={aiShikiAdapter}>
      <Paper
        withBorder
        radius="lg"
        my="xs"
        data-myoxus-ui-role="ai-code-block"
        style={{
          overflow: "hidden",
          background: "var(--myoxus-background-code-block)",
        }}
      >
        <Group
          justify="space-between"
          align="center"
          wrap="nowrap"
          data-myoxus-ui-role="code-block-header"
          style={{
            height: "36px",
            minHeight: "36px",
            padding: "0 8px 0 12px",
            background: "var(--myoxus-background-secondary-color)",
            borderBottom: "1px solid var(--myoxus-border-color)",
          }}
        >
          <Group gap="xs" align="center" wrap="nowrap" miw={0}>
            <CodeIcon
              width={14}
              height={14}
              style={{
                flexShrink: 0,
                color: "var(--myoxus-icon-secondary)",
              }}
            />
            <MyoxusText
              component="span"
              typographySlot="body-small"
              tone="secondary"
              truncate
              style={{ fontWeight: 500 }}
            >
              {headerLanguage}
            </MyoxusText>
          </Group>
          <CopyButton value={source} timeout={2000}>
            {({ copied, copy }) => (
              <Button
                variant="plain"
                aria-label={copied ? t["Copied to clipboard"]() : t["Copy"]()}
                tooltip={copied ? t["Copied to clipboard"]() : t["Copy"]()}
                prefix={
                  copied ? (
                    <DoneIcon width={15} height={15} />
                  ) : (
                    <CopyIcon width={15} height={15} />
                  )
                }
                style={{
                  height: "28px",
                  minHeight: "28px",
                  paddingInline: "8px",
                  fontSize: "var(--mantine-font-size-xs)",
                  fontWeight: 500,
                  color: copied
                    ? "var(--myoxus-success-color)"
                    : "var(--myoxus-text-secondary-color)",
                }}
                onClick={copy}
              >
                {t["Copy"]()}
              </Button>
            )}
          </CopyButton>
        </Group>
        <CodeHighlight
          code={source}
          language={resolvedLanguage}
          codeColorScheme={
            resolvedTheme === "dark" ? "dark-plus" : "light-plus"
          }
          withBorder={false}
          radius={0}
          withCopyButton={false}
          withLineNumbers={showLineNumbers}
        />
      </Paper>
    </CodeHighlightAdapterProvider>
  );
}

function Callout({
  data,
  children,
}: {
  data: Parameters<MarkdownPreviewPresentation["callout"]>[0];
  children: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(data.calloutDefaultOpen !== false);
  const kind = data.calloutType;
  const appearance = calloutPresentation(kind ?? "note");
  return (
    <Alert
      bg={
        editorBackgroundColors.find(
          ({ name }) => name === appearance.background,
        )?.background
      }
      icon={data.calloutEmoji || appearance.icon}
      title={
        kind && (
          <CalloutTitle
            type={kind}
            title={data.calloutTitle ?? ""}
            readonly
            foldable={data.calloutFoldable}
            expanded={expanded}
            toggle={() => setExpanded(!expanded)}
            focusEditor={() => {}}
            apply={() => false}
          />
        )
      }
    >
      {expanded && children}
    </Alert>
  );
}

import type { PageAiBridge } from "../../../virgultum/doc-editor/page-ai-bridge";
import type { Store } from "@virgultum/core/store";

export function StoredAnswerText({
  host,
  store,
  pageBridge,
  text,
  annotation = false,
  documentLink,
  testId = "ai-text-renderer",
}: {
  host?: EditorHost | null;
  store?: Store | null;
  pageBridge?: PageAiBridge | null;
  text: string;
  annotation?: boolean;
  documentLink?: MarkdownPreviewPresentation["documentLink"];
  testId?: string;
}) {
  const activeStore = store ?? host?.store ?? pageBridge?.store ?? null;
  const presentation = useMemo<MarkdownPreviewPresentation>(
    () => ({
      heading: (depth, children, followed) => (
        <MyoxusTitle
          mb={
            followed
              ? "calc(var(--mantine-spacing-sm) + var(--mantine-spacing-2xs))"
              : undefined
          }
          order={depth}
          typographySlot={`h${depth}`}
        >
          {children}
        </MyoxusTitle>
      ),
      code: (source, language) => (
        <HighlightedCode source={source} language={language} />
      ),
      callout: (data, children) => (
        <Callout
          key={JSON.stringify([
            data.calloutType,
            data.calloutTitle,
            data.calloutDefaultOpen,
          ])}
          data={data}
        >
          {children}
        </Callout>
      ),
      citation: (footnote) =>
        activeStore ? (
          <CitationMarker store={activeStore} footnote={footnote} />
        ) : null,
      annotation: (body) =>
        host?.std.getOptional(AnnotationReactHostIdentifier)
          ?.showAnnotations ? (
          <AnnotationInline
            id={body}
            body={body}
            readonly
            apply={() => false}
            remove={() => false}
            focusEditor={() => {}}
          />
        ) : null,
      inlineHtml: (children, start) => {
        if (!activeStore) return null;
        using job = activeStore.getTransformer();
        const group = new MarkdownAdapter(
          job,
          activeStore.provider,
        ).deltaConverter.readInlineHtmlGroup(children, start);
        if (!group) return null;
        return {
          endIndex: group.endIndex,
          view: group.deltas.map(({ insert, attributes }, i) => {
            if (typeof insert !== "string") return null;
            const style = Object.fromEntries(
              Object.entries(myoxusTextStyles(attributes ?? {}))
                .filter(
                  (entry): entry is [string, string | number] =>
                    entry[1] != null,
                )
                .map(([k, v]) => [
                  k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()),
                  v,
                ]),
            );
            return (
              <span key={i} style={style}>
                {insert}
              </span>
            );
          }),
        };
      },
      documentLink: (url, children) => {
        if (documentLink) {
          const custom = documentLink(url, children);
          if (custom) return custom;
        }
        if (host) {
          const target = host.std
            .getOptional(ParseDocUrlProvider)
            ?.parseDocUrl(url);
          const peek = host.std.getOptional(PeekViewProvider);
          if (!target || !peek) return null;
          return (
            <a
              href={url}
              onClick={(event) => {
                event.preventDefault();
                void peek.peek(target).catch(console.error);
              }}
            >
              {children}
            </a>
          );
        }
        if (pageBridge) {
          return (
            <a
              href={url}
              onClick={(event) => {
                if (pageBridge.openDocLink(url)) {
                  event.preventDefault();
                }
              }}
            >
              {children}
            </a>
          );
        }
        return null;
      },
      image: (raw, alt) => {
        // Keep the origin of every fetch under the configured image proxy, including
        // when a saved answer contains a URL shaped like another server's proxy.
        if (!URL.canParse(raw)) return alt || raw;
        const source = new URL(raw);
        if (!["http:", "https:"].includes(source.protocol)) return alt || raw;
        const endpoint = new URL(
          host?.std.clipboard.configs.get("imageProxy") ??
            BUILD_CONFIG.imageProxyUrl,
          location.href,
        );
        return (
          <MediaPreviewImage
            src={buildImageProxyURL(source.href, endpoint.href)}
            alt={alt}
          />
        );
      },
      equation: (source, display) => (
        <Equation source={source} display={display} />
      ),
    }),
    [activeStore, documentLink, host, pageBridge],
  );
  return (
    <MyoxusText
      component="div"
      data-testid={testId}
      typographySlot={annotation ? "body-small" : "body"}
      tone={annotation ? "secondary" : "primary"}
      italic={annotation}
    >
      <Typography>
        <MarkdownPreview source={text} presentation={presentation} />
      </Typography>
    </MyoxusText>
  );
}
