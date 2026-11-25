// SPDX-License-Identifier: AGPL-3.0-or-later
import { WorkspaceServerService } from "../../../modules/server";
import { useService, useFramework } from "@myoxus/infra";
import { notify } from "@myoxus/ui-facade";
import { copyEditorBlockLink } from "../../../components/hooks/myoxus/use-share-url";
import { useI18n } from "@myoxus/i18n";
import { useMyoxusTheme } from "@myoxus/ui-facade/provider";
import type { CodeBlockModel } from "@virgultum/core/models";
import { BRACKET_PAIRS } from "@virgultum/core/consts";
import type {
  EditorCodeToolbarState,
  SelectionAction,
} from "@virgultum/core/services";
import {
  bundledLanguagesInfo,
  codeToTokensBase,
  codeLanguageOptions,
  readLanguageOrder,
  saveLanguageOrder,
  type ThemedToken,
} from "@virgultum/content/syntax-highlighter";
import {
  lazy,
  Suspense,
  useRef,
  useLayoutEffect,
  useEffect,
  useState,
  useMemo,
} from "react";
import { EditorCodeToolbar } from "../../view-extensions/editor-view/editor-chrome/code-toolbar";
import {
  continueInChat,
  reviewCodeActions,
} from "../../ai/_common/code-actions";
import { bindPageTextarea } from "./page-textarea";
import { usePageCaption } from "./page-caption";
import { duplicatePageBlock } from "./page-block-actions";
import { resolveInsertParent } from "./page-slash-registry";
import { ViewService } from "../../../modules/workbench";

const Preview = lazy(async () => ({
  default: (await import("../../view-extensions/code-block-preview/preview"))
    .CodePreview,
}));

export default function PageCode({
  model,
  readonly,
  enableComment,
  enableAI,
}: {
  model: CodeBlockModel;
  enableAI: boolean;
  enableComment: boolean;
  readonly: boolean;
}) {
  const t = useI18n(),
    { resolvedTheme } = useMyoxusTheme();
  const workspaceServer = useService(WorkspaceServerService);
  const framework = useFramework();
  const copyOwner = useRef<AbortController | null>(null);
  useLayoutEffect(() => {
    const owner = new AbortController();
    copyOwner.current = owner;
    return () => owner.abort();
  }, [model]);
  const copyCode = async () => {
    const signal = copyOwner.current?.signal;
    if (!signal || signal.aborted || !field.current?.isConnected) return;
    try {
      const { copyPageBlock } = await import("./page-block-copy");
      await copyPageBlock(model, framework, signal);
      if (!signal.aborted) notify({ title: t["Copied to clipboard"]() });
    } catch (error) {
      if (signal.aborted) return;
      notify({ title: t["com.myoxus.editor.clipboard.copy-failed"]() });
      console.error(error);
    }
  };
  const captionEditor = usePageCaption(model, readonly);
  const field = useRef<HTMLTextAreaElement>(null),
    paint = useRef<HTMLPreElement>(null);
  const { text, language, wrap, lineNumber } = model.props,
    store = model.store,
    source = text.toString();
  const [hover, setHover] = useState(false),
    [active, setActive] = useState(false);
  const [localPreview, setLocalPreview] = useState<boolean | null>(null);
  const previewLanguage =
    language === "html" || language === "mermaid" || language === "typst"
      ? language
      : undefined;
  const showPreview =
    !!previewLanguage &&
    (readonly
      ? (localPreview ?? !!model.props.preview)
      : !!model.props.preview);
  const [recent, setRecent] = useState(readLanguageOrder);
  const languages = useMemo(
    () => codeLanguageOptions(bundledLanguagesInfo, language, recent),
    [language, recent],
  );
  const lang = bundledLanguagesInfo.find(
    (l) =>
      l.id === language ||
      l.name === language ||
      l.aliases?.includes(language ?? ""),
  );
  const [result, setResult] = useState<{
    source: string;
    language: string;
    theme: string;
    tokens: ThemedToken[][];
  }>();
  useLayoutEffect(
    () =>
      bindPageTextarea(
        field.current!,
        text.yText,
        store,
        () =>
          store.getModelById(model.id) === model && model.props.text === text,
      ),
    [model, text, store],
  );
  useEffect(() => {
    if (!lang || showPreview) return;
    let live = true;
    void codeToTokensBase(source, {
      lang: lang.id,
      theme: resolvedTheme === "dark" ? "dark-plus" : "light-plus",
    })
      .then((tokens) => {
        if (live)
          setResult({
            source,
            language: lang.id,
            theme: resolvedTheme,
            tokens,
          });
      })
      .catch(console.error);
    return () => {
      live = false;
    };
  }, [source, lang, resolvedTheme, showPreview]);
  const tokens =
    result?.source === source &&
    result.language === lang?.id &&
    result.theme === resolvedTheme
      ? result.tokens
      : undefined;
  const writable = () =>
    !readonly && !store.readonly && store.getModelById(model.id) === model;
  const convertToMermaid = () => {
    if (!writable()) return;
    const rawSource = model.props.text.toString();
    void (async () => {
      const { createMermaidBlockInsertProps } =
        await import("@virgultum/block-mermaid");
      if (!writable()) return;
      const target = resolveInsertParent(store, model, "myoxus:mermaid");
      if (!target) return;
      const { flavour: _f, ...mermaidProps } = createMermaidBlockInsertProps({
        source: rawSource,
      });
      store.captureSync();
      store.transact(() => {
        store.addBlock(
          "myoxus:mermaid",
          mermaidProps,
          target.parent,
          target.index + 1,
        );
        if (target.anchor === model) store.deleteBlock(model);
      });
      store.captureSync();
    })().catch(console.error);
  };
  const action = (
    id: string,
    label: string,
    icon: SelectionAction["icon"],
    run: () => void,
    active?: boolean,
  ): SelectionAction => ({ id, label, icon, disabled: readonly, run, active });
  const toggle = (props: {
    wrap?: boolean;
    lineNumber?: boolean;
    preview?: boolean;
  }) => {
    if (writable()) {
      store.captureSync();
      store.updateBlock(model, props);
      store.captureSync();
    }
  };
  const state: EditorCodeToolbarState = {
    language: lang?.id ?? "",
    languageName: lang?.name ?? t.Text(),
    languages,
    readonly,
    primary: [
      ...(previewLanguage
        ? [
            {
              ...action(
                "preview",
                t["com.myoxus.editor.toolbar.preview"](),
                "PresentationIcon",
                () => {
                  if (readonly) setLocalPreview(!showPreview);
                  else toggle({ preview: !showPreview });
                },
                showPreview,
              ),
              disabled: false,
            },
          ]
        : []),
      ...(enableAI && !readonly
        ? [
            {
              id: "ask-ai",
              label: t["com.myoxus.editor.toolbar.ask-ai"](),
              disabled: false,
              icon: "AiIcon" as const,
              control: {
                type: "menu" as const,
                onOpen: () => setActive(true),
                onClose: () => setActive(false),
                items: [reviewCodeActions, [continueInChat]].map(
                  (items, index) => ({
                    id: `ai-group-${index}`,
                    label: `ai-group-${index}`,
                    disabled: false,
                    actions: items.map(({ testId, name, iconName }) =>
                      action(testId, name, iconName, () => {
                        if (writable())
                          framework
                            .getOptional(ViewService)
                            ?.view.showTool("chat");
                      }),
                    ),
                  }),
                ),
              },
            },
          ]
        : []),
      {
        ...action(
          "copy-code",
          t["com.myoxus.editor.toolbar.copy-code"](),
          "CopyIcon",
          () => void copyCode(),
        ),
        disabled: false,
      },
      ...(!readonly
        ? [
            action(
              "caption",
              t["com.myoxus.editor.toolbar.caption"](),
              "CaptionIcon",
              captionEditor.show,
            ),
          ]
        : []),
      ...(enableComment
        ? [
            {
              ...action(
                "comment",
                t["com.myoxus.editor.toolbar.comment"](),
                "CommentIcon",
                () =>
                  framework.getOptional(ViewService)?.view.showTool("comment"),
              ),
              disabled: false,
            },
          ]
        : []),
    ],
    more: [
      action(
        "wrap",
        t["com.myoxus.editor.code.wrap"](),
        "TextIcon",
        () => toggle({ wrap: !wrap }),
        wrap,
      ),
      action(
        "line-number",
        t["com.myoxus.editor.code.line-numbers"](),
        "NumberedListIcon",
        () => toggle({ lineNumber: !(lineNumber ?? true) }),
        lineNumber ?? true,
      ),
      {
        ...action(
          "copy-link-to-block",
          t["com.myoxus.editor.toolbar.copy-link-to-block"](),
          "LinkIcon",
          () => {
            if (
              !field.current?.isConnected ||
              store.getModelById(model.id) !== model
            )
              return;
            void copyEditorBlockLink(
              {
                pageId: store.id,
                workspaceId: store.workspace.id,
                blockIds: [model.id],
                mode: "page",
                baseUrl: workspaceServer.server?.baseUrl ?? location.origin,
              },
              model.flavour,
            ).catch(console.error);
          },
        ),
        disabled: false,
      },
      action(
        "duplicate",
        t["com.myoxus.editor.keyboard.duplicate"](),
        "DuplicateIcon",
        () => {
          if (writable()) duplicatePageBlock(model);
        },
      ),
      {
        ...action("delete", t.Delete(), "DeleteIcon", () => {
          if (writable()) store.deleteBlock(model);
        }),
        variant: "destructive",
      },
    ],
  };
  const sync = () => {
    if (paint.current && field.current) {
      paint.current.scrollLeft = field.current.scrollLeft;
      paint.current.scrollTop = field.current.scrollTop;
    }
  };
  return (
    <div
      data-page-code={model.id}
      data-block-id={model.id}
      contentEditable={false}
      tabIndex={-1}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {(hover || active) && (
        <div data-code-toolbar="">
          <EditorCodeToolbar
            controls={{
              getSnapshot: () => state,
              subscribe: () => () => {},
              setActive,
              chooseLanguage: (id) => {
                if (writable() && languages.some((l) => l.value === id)) {
                  store.captureSync();
                  store.updateBlock(model, { language: id });
                  const next = [id, ...recent.filter((value) => value !== id)];
                  setRecent(next);
                  saveLanguageOrder(
                    codeLanguageOptions(bundledLanguagesInfo, id, next),
                  );
                  store.captureSync();
                  queueMicrotask(() => {
                    if (field.current?.checkVisibility()) field.current.focus();
                  });
                }
              },
            }}
          />
        </div>
      )}
      <div
        data-code-source=""
        hidden={showPreview}
        data-wrap={wrap || undefined}
      >
        {lineNumber !== false && (
          <pre aria-hidden data-code-gutter="">
            {source
              .split("\n")
              .map((_, i) => i + 1)
              .join("\n")}
          </pre>
        )}
        <div data-code-lines="">
          <pre aria-hidden ref={paint} data-code-paint="">
            {tokens
              ? tokens.map((row, i) => (
                  <span key={i}>
                    {i ? "\n" : ""}
                    {row.map((token, j) => (
                      <span key={j} style={{ color: token.color }}>
                        {token.content}
                      </span>
                    ))}
                  </span>
                ))
              : source}
            {"\n"}
          </pre>
          <textarea
            ref={field}
            aria-label={t["com.myoxus.editor.keyboard.code"]()}
            readOnly={readonly}
            defaultValue={source}
            rows={1}
            wrap={wrap ? "soft" : "off"}
            onScroll={sync}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || !writable()) return;
              const el = e.currentTarget,
                a = el.selectionStart,
                b = el.selectionEnd;
              if (!e.metaKey && !e.ctrlKey && !e.altKey) {
                const value = text.toString(),
                  pair = BRACKET_PAIRS.find((p) => p.left === e.key),
                  around = BRACKET_PAIRS.find(
                    (p) => p.left === value[a - 1] && p.right === value[b],
                  );
                if (e.key === "Backspace" && a === b && around) {
                  e.preventDefault();
                  store.transact(() => text.delete(a - 1, 2));
                  el.setSelectionRange(a - 1, a - 1);
                  return;
                }
                if (pair) {
                  e.preventDefault();
                  store.transact(() => {
                    text.insert(pair.right, b);
                    text.insert(pair.left, a);
                  });
                  el.setSelectionRange(
                    a + pair.left.length,
                    b + pair.left.length,
                  );
                  return;
                }
                if (a === b && around?.right === e.key) {
                  e.preventDefault();
                  el.setSelectionRange(a + 1, a + 1);
                  return;
                }
                if (e.key === "Enter") store.captureSync();
              }
              if (
                (e.ctrlKey || e.metaKey) &&
                ["z", "y"].includes(e.key.toLowerCase())
              ) {
                e.preventDefault();
                e.key.toLowerCase() === "y" || e.shiftKey
                  ? store.redo()
                  : store.undo();
                return;
              }
              if (
                e.key === "Enter" &&
                (e.ctrlKey || e.metaKey) &&
                a === b &&
                a === text.length &&
                model.parent
              ) {
                e.preventDefault();
                store.captureSync();
                const id = store.addBlock(
                  "myoxus:paragraph",
                  {},
                  model.parent,
                  model.parent.children.indexOf(model) + 1,
                );
                store.captureSync();
                requestAnimationFrame(() => {
                  const root = el.closest("[data-page-renderer]"),
                    target = root?.querySelector(
                      `[data-page-text="${CSS.escape(id)}"]`,
                    );
                  if (target) {
                    root
                      ?.querySelector<HTMLElement>("[data-page-body]")
                      ?.focus();
                    document.getSelection()?.collapse(target, 0);
                  }
                });
                return;
              }
              if (e.key === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey) {
                e.preventDefault();
                const content = text.toString(),
                  starts = [a === 0 ? 0 : content.lastIndexOf("\n", a - 1) + 1];
                for (let i = a; i < b; i++)
                  if (content[i] === "\n") starts.push(i + 1);
                let from = a,
                  to = b;
                store.captureSync();
                store.transact(() => {
                  for (const i of starts.reverse()) {
                    if (e.shiftKey) {
                      if (content.slice(i, i + 2) !== "  ") continue;
                      text.delete(i, 2);
                      from -= Math.min(2, Math.max(0, a - i));
                      to -= Math.min(2, Math.max(0, b - i));
                    } else {
                      text.insert("  ", i);
                      if (i <= a) from += 2;
                      to += 2;
                    }
                  }
                });
                store.captureSync();
                el.setSelectionRange(from, to);
              }
            }}
          />
        </div>
      </div>
      {previewLanguage && showPreview && (
        <Suspense fallback={null}>
          <Preview
            language={previewLanguage}
            source={source}
            convertMermaid={
              previewLanguage === "mermaid" && !readonly
                ? convertToMermaid
                : undefined
            }
          />
        </Suspense>
      )}
      {captionEditor.field}
    </div>
  );
}
