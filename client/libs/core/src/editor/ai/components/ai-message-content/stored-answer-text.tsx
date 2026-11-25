// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import {
  Alert,
  Box,
  Group,
  MediaPreviewImage,
  MyoxusText,
  MyoxusTitle,
  Scrollable,
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
import type { ThemedToken } from "@virgultum/content/syntax-highlighter";
import { AnnotationReactHostIdentifier } from "@virgultum/editor/blocks/annotation";
import { AnnotationInline } from "../../../view-extensions/editor-view/annotation";
import { CalloutTitle } from "../../../view-extensions/editor-view/callout";
import { CitationMarker } from "../../../virgultum/doc-editor/page-citation";
import { Fragment, useState, useEffect, useMemo, useRef } from "react";
import {
  MarkdownPreview,
  type MarkdownPreviewPresentation,
} from "../../../attachment-viewer/text/markdown-preview";

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
  const { resolvedTheme } = useMyoxusTheme();
  const [result, setResult] = useState<{
    source: string;
    language: string;
    theme: string;
    tokens: ThemedToken[][];
  }>();
  useEffect(() => {
    if (!language) return;
    let live = true;
    void import("@virgultum/content/syntax-highlighter")
      .then(async ({ bundledLanguagesInfo, codeToTokensBase }) => {
        const lang = bundledLanguagesInfo.find(
          (l) =>
            l.id === language ||
            l.name === language ||
            l.aliases?.includes(language),
        );
        if (!lang) return;
        const tokens = await codeToTokensBase(source, {
          lang: lang.id,
          theme: resolvedTheme === "dark" ? "dark-plus" : "light-plus",
        });
        if (live) setResult({ source, language, theme: resolvedTheme, tokens });
      })
      .catch(console.error);
    return () => {
      live = false;
    };
  }, [source, language, resolvedTheme]);
  const tokens =
    result?.source === source &&
    result.language === language &&
    result.theme === resolvedTheme
      ? result.tokens
      : undefined;

  const codeContent = (
    <code>
      {tokens
        ? tokens.map((row, i) => (
            <Fragment key={i}>
              {i > 0 && "\n"}
              {row.map((t, j) => (
                // Shiki returns per-token color data. This inline style is renderer
                // content, not product chrome, and cannot be represented as static theme CSS.
                <span key={j} style={{ color: t.color }}>
                  {t.content}
                </span>
              ))}
            </Fragment>
          ))
        : source}
    </code>
  );

  if (!showLineNumbers) {
    return <pre style={{ whiteSpace: "pre-wrap" }}>{codeContent}</pre>;
  }

  const lineCount = tokens ? tokens.length : source.split("\n").length;
  return (
    <Scrollable.Root
      display="flex"
      flexDirection="column"
      flex={1}
      minHeight={0}
    >
      <Scrollable.Viewport fill>
        <Group align="flex-start" wrap="nowrap" gap="md" p="md">
          <Box
            aria-hidden="true"
            style={{ userSelect: "none", textAlign: "right", flexShrink: 0 }}
          >
            <MyoxusText
              component="div"
              tone="secondary"
              typographySlot="code"
              preserveWhitespace
            >
              {Array.from({ length: lineCount }, (_, i) => i + 1).join("\n")}
            </MyoxusText>
          </Box>
          <MyoxusText
            component="div"
            typographySlot="code"
            preserveWhitespace
            flex={1}
          >
            {codeContent}
          </MyoxusText>
        </Group>
      </Scrollable.Viewport>
    </Scrollable.Root>
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

export function StoredAnswerText({
  host,
  text,
  annotation = false,
  documentLink,
  testId = "ai-text-renderer",
}: {
  host?: EditorHost | null;
  text: string;
  annotation?: boolean;
  documentLink?: MarkdownPreviewPresentation["documentLink"];
  testId?: string;
}) {
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
        host ? <CitationMarker store={host.store} footnote={footnote} /> : null,
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
        if (!host) return null;
        using job = host.store.getTransformer();
        const group = new MarkdownAdapter(
          job,
          host.store.provider,
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
        if (!host) return null;
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
    [host, documentLink],
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
