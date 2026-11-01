import {
  DOCUMENT_REFERENCE_PATH_PREFIX,
  DOCUMENT_REFERENCE_SOURCE_PATH,
  DOCUMENT_REFERENCE_TITLE_PREFIX,
  DOCUMENT_REFERENCE_CURRENT_DOCUMENT,
  DOCUMENT_REFERENCE_TARGETS_PREFIX,
  DOCUMENT_REFERENCE_NATIVE_TARGET_PREFIX,
  configuredMarkdownTarget,
  type MarkdownImportDiagnostics,
  type MarkdownASTToDeltaMatcher,
  MarkdownASTToDeltaExtension,
  resolveMarkdownRelativePath,
} from "@virgultum/shared/adapters";

const WIKILINK_SCHEME = "myoxus-wikilink:";
type WikiLinkData = {
  myoxusWikiAlias?: string;
  myoxusWikiSource?: string;
  myoxusWikiTarget?: string;
  myoxusWikiUnsupported?: boolean;
  myoxusWikiEmbed?: boolean;
};

function reportDiagnostic(
  diagnostics: MarkdownImportDiagnostics | undefined,
  kind: "unresolvedReferences" | "unsupportedReferences",
) {
  if (diagnostics) diagnostics[kind] += 1;
}

function resolveBatchPath(target: string, configs: Map<string, unknown>) {
  const sourcePath = configs.get(DOCUMENT_REFERENCE_SOURCE_PATH);
  if (typeof sourcePath === "string") {
    const path = resolveMarkdownRelativePath(sourcePath, target);
    const id = path && configs.get(DOCUMENT_REFERENCE_PATH_PREFIX + path);
    if (typeof id === "string") return id;
  }
  return;
}

function isPathLikeWikiTarget(target: string) {
  if (
    target.includes("/") ||
    target.includes("\\") ||
    target.startsWith(".") ||
    target.toLowerCase().endsWith(".md") ||
    /^[a-z]:/i.test(target)
  ) {
    return true;
  }
  try {
    const decoded = decodeURIComponent(target);
    return (
      decoded.includes("/") ||
      decoded.includes("\\") ||
      decoded.startsWith(".") ||
      /^[a-z]:/i.test(decoded)
    );
  } catch {
    return false;
  }
}

function resolveWikilink(target: string, configs: Map<string, unknown>) {
  for (const candidate of [
    target,
    target.toLowerCase().endsWith(".md") ? undefined : `${target}.md`,
  ]) {
    if (!candidate) continue;
    const id = resolveBatchPath(candidate, configs);
    if (id) return id;
  }
  if (isPathLikeWikiTarget(target)) return;
  const expectedTitle = target.toLowerCase().endsWith(".md")
    ? target.slice(0, -3)
    : target;
  let resolved: string | undefined;
  for (const [key, value] of configs) {
    if (
      !key.startsWith(DOCUMENT_REFERENCE_TITLE_PREFIX) ||
      value !== expectedTitle
    )
      continue;
    if (resolved) return;
    resolved = key.slice(DOCUMENT_REFERENCE_TITLE_PREFIX.length);
  }
  return resolved;
}

function preciseParams(
  pageId: string,
  encodedFragment: string,
  context: Parameters<MarkdownASTToDeltaMatcher["toDelta"]>[1],
) {
  let fragment: string;
  try {
    fragment = decodeURIComponent(encodedFragment);
  } catch {
    reportDiagnostic(context.markdownImportDiagnostics, "unresolvedReferences");
    return;
  }
  const resolved = configuredMarkdownTarget(context.configs, pageId, fragment);
  if ("error" in resolved) {
    reportDiagnostic(
      context.markdownImportDiagnostics,
      resolved.error === "unsupported"
        ? "unsupportedReferences"
        : "unresolvedReferences",
    );
    return;
  }
  return { mode: "page" as const, blockIds: [resolved.blockId] };
}

export const markdownLinkToDeltaMatcher = MarkdownASTToDeltaExtension({
  name: "link",
  match: (ast) => ast.type === "link",
  toDelta: (ast, context) => {
    if (!("children" in ast) || !("url" in ast)) {
      return [];
    }
    const { configs } = context;
    const wiki = (ast.data ?? {}) as WikiLinkData;
    if (ast.url.startsWith(WIKILINK_SCHEME) && wiki.myoxusWikiTarget) {
      const fragmentAt = wiki.myoxusWikiTarget.indexOf("#");
      if (
        wiki.myoxusWikiUnsupported &&
        (wiki.myoxusWikiEmbed || fragmentAt < 0)
      ) {
        reportDiagnostic(
          context.markdownImportDiagnostics,
          "unsupportedReferences",
        );
        return [
          { insert: wiki.myoxusWikiSource ?? `[[${wiki.myoxusWikiTarget}]]` },
        ];
      }
      // A reference-preserving single-document export has no archive path plan.
      // Its own-workspace URL uses the same authorized resolver as normal links.
      if (/^https?:\/\//i.test(wiki.myoxusWikiTarget)) {
        return context.toDelta({
          ...ast,
          url: wiki.myoxusWikiTarget,
          data: undefined,
        });
      }
      const documentTarget =
        fragmentAt < 0
          ? wiki.myoxusWikiTarget
          : wiki.myoxusWikiTarget.slice(0, fragmentAt);
      const pageId = documentTarget
        ? resolveWikilink(documentTarget, configs)
        : configs.get(DOCUMENT_REFERENCE_CURRENT_DOCUMENT);
      if (!pageId) {
        reportDiagnostic(
          context.markdownImportDiagnostics,
          "unresolvedReferences",
        );
        return [
          { insert: wiki.myoxusWikiSource ?? `[[${wiki.myoxusWikiTarget}]]` },
        ];
      }
      const params =
        fragmentAt < 0
          ? undefined
          : preciseParams(
              pageId,
              wiki.myoxusWikiTarget.slice(fragmentAt + 1),
              context,
            );
      context.onDocumentReference?.(pageId);
      if (fragmentAt >= 0 && !params)
        return [
          { insert: wiki.myoxusWikiSource ?? `[[${wiki.myoxusWikiTarget}]]` },
        ];
      return [
        {
          insert: " ",
          attributes: {
            reference: {
              type: "LinkedPage",
              pageId,
              title: wiki.myoxusWikiAlias,
              ...(params ? { params } : {}),
            },
          },
        },
      ];
    }
    const relativePath = ast.url.split(/[?#]/, 1)[0];
    const fragmentAt = ast.url.indexOf("#");
    if (
      !ast.url.includes("?") &&
      (relativePath.toLowerCase().endsWith(".md") ||
        (!relativePath && fragmentAt === 0))
    ) {
      const pageId = relativePath
        ? resolveBatchPath(relativePath, configs)
        : configs.get(DOCUMENT_REFERENCE_CURRENT_DOCUMENT);
      if (pageId) {
        context.onDocumentReference?.(pageId);
        const params =
          fragmentAt < 0
            ? undefined
            : preciseParams(pageId, ast.url.slice(fragmentAt + 1), context);
        if (fragmentAt >= 0 && !params)
          return ast.children.flatMap((child) =>
            context.toDelta(child).map((delta) => ({
              ...delta,
              attributes: { ...delta.attributes, link: ast.url },
            })),
          );
        const label = ast.children
          .flatMap((child) => context.toDelta(child))
          .map((delta) => delta.insert)
          .join("");
        return [
          {
            insert: " ",
            attributes: {
              reference: {
                type: "LinkedPage",
                pageId,
                title: label || undefined,
                ...(params ? { params } : {}),
              },
            },
          },
        ];
      }
      reportDiagnostic(
        context.markdownImportDiagnostics,
        "unresolvedReferences",
      );
    }
    const baseUrl = configs.get("docLinkBaseUrl") ?? "";
    if (baseUrl) {
      let base: URL | undefined;
      let target: URL | undefined;
      try {
        base = new URL(baseUrl);
        target = new URL(ast.url);
      } catch {
        // Invalid and relative destinations remain ordinary Markdown links.
      }
      const basePath = base?.pathname.replace(/\/+$/, "") ?? "";
      if (
        base &&
        target &&
        target.origin === base.origin &&
        !target.username &&
        !target.password
      ) {
        const targetPath = target.pathname;
        const suffix = targetPath.startsWith(`${basePath}/`)
          ? targetPath.slice(basePath.length + 1)
          : undefined;
        if (suffix && !suffix.includes("/")) {
          let pageId: string | undefined;
          try {
            pageId = decodeURIComponent(suffix);
          } catch {
            // Malformed percent escapes cannot identify a local document.
          }
          if (pageId && !pageId.includes("/")) {
            const authorizedTitle = configs.get(
              DOCUMENT_REFERENCE_TITLE_PREFIX + pageId,
            );
            if (typeof authorizedTitle !== "string") {
              reportDiagnostic(
                context.markdownImportDiagnostics,
                "unresolvedReferences",
              );
              return ast.children.flatMap((child) =>
                context.toDelta(child).map((delta) => ({
                  ...delta,
                  attributes: { ...delta.attributes, link: ast.url },
                })),
              );
            }
            const searchParams = target.searchParams;
            context.onDocumentReference?.(pageId);
            if (target.hash) {
              const params = target.search
                ? undefined
                : preciseParams(pageId, target.hash.slice(1), context);
              if (!params) {
                if (target.search)
                  reportDiagnostic(
                    context.markdownImportDiagnostics,
                    "unsupportedReferences",
                  );
                return ast.children.flatMap((child) =>
                  context.toDelta(child).map((delta) => ({
                    ...delta,
                    attributes: { ...delta.attributes, link: ast.url },
                  })),
                );
              }
              const label = ast.children
                .flatMap((child) => context.toDelta(child))
                .map((delta) => delta.insert)
                .join("");
              return [
                {
                  insert: " ",
                  attributes: {
                    reference: {
                      type: "LinkedPage",
                      pageId,
                      title: label || undefined,
                      params,
                    },
                  },
                },
              ];
            }
            const mode = searchParams?.get("mode");
            const blockIds = searchParams?.get("blockIds")?.split(",");
            if (
              blockIds?.length &&
              configs.has(DOCUMENT_REFERENCE_TARGETS_PREFIX + pageId) &&
              blockIds.some(
                (id) =>
                  !configs.has(
                    DOCUMENT_REFERENCE_NATIVE_TARGET_PREFIX +
                      JSON.stringify([pageId, id]),
                  ),
              )
            ) {
              reportDiagnostic(
                context.markdownImportDiagnostics,
                "unresolvedReferences",
              );
              return ast.children.flatMap((child) =>
                context.toDelta(child).map((delta) => ({
                  ...delta,
                  attributes: { ...delta.attributes, link: ast.url },
                })),
              );
            }
            const elementIds = searchParams?.get("elementIds")?.split(",");
            const xywh = searchParams.get("xywh");
            const validXywh = /^\[\d+,\d+,\d+,\d+\]$/.test(xywh ?? "")
              ? (xywh as `[${number},${number},${number},${number}]`)
              : undefined;
            const label = ast.children
              .flatMap((child) => context.toDelta(child))
              .map((delta) => delta.insert)
              .join("");

            return [
              {
                insert: " ",
                attributes: {
                  reference: {
                    type: "LinkedPage",
                    pageId,
                    title: label || undefined,
                    params: {
                      mode:
                        mode && ["edgeless", "page"].includes(mode)
                          ? (mode as "edgeless" | "page")
                          : undefined,
                      blockIds,
                      elementIds,
                      databaseId: searchParams.get("databaseId") ?? undefined,
                      databaseRowId:
                        searchParams.get("databaseRowId") ?? undefined,
                      xywh: validXywh,
                      commentId: searchParams.get("commentId") ?? undefined,
                    },
                  },
                },
              },
            ];
          }
        }
      }
    }
    return ast.children.flatMap((child) =>
      context.toDelta(child).map((delta) => {
        delta.attributes = { ...delta.attributes, link: ast.url };
        return delta;
      }),
    );
  },
});
