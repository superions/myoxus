// SPDX-License-Identifier: AGPL-3.0-or-later
import { usePageCaption } from "./page-caption";
import { useEffect, useMemo, useRef, useState } from "react";
import { useFramework, useService } from "@myoxus/infra";
import { useI18n } from "@myoxus/i18n";
import { ReferenceCard, IconButton, Box } from "@myoxus/ui-facade";
import { FileIconHtmlIcon, ExpandIcon } from "@myoxus/icons/react";
import {
  EmbedLoomModel,
  type EmbedIframeBlockModel,
  type EmbedHtmlModel,
  type EmbedGithubModel,
  type EmbedGithubBlockUrlData,
  EmbedYoutubeModel,
  type EmbedFigmaModel,
  type EmbedYoutubeBlockUrlData,
} from "@virgultum/core/models";
import { EMBED_CARD_HEIGHT } from "@virgultum/core/consts";
import { copyTextToClipboard } from "@virgultum/core/primitives/utils";
import {
  LinkPreviewCache,
  type EditorSelectionState,
  type SelectionAction,
} from "@virgultum/core/services";
import { EmbedIframeService } from "@virgultum/core/services/data";
import {
  iframeSandbox,
  safeGetIframeSrc,
} from "@virgultum/embeds/provider-data";
import { EditorIframeLinkEditor } from "../../view-extensions/editor-view/editor-chrome/iframe-link-editor";
import { EditorIframeStatusCard } from "../../view-extensions/editor-view/editor-chrome/iframe-status-card";
import { normalizeUrl, isValidUrl } from "@virgultum/core/utils";
import { buildImageProxyURL } from "@virgultum/core/adapters";
import {
  queryEmbedLoomData,
  queryEmbedYoutubeData,
  loomUrlRegex,
  youtubeUrlRegex,
  queryEmbedGithubApiData,
  queryEmbedGithubData,
  formatForgeCardDate,
  parseCardUrl,
  parseGitForgeUrl,
  resolveGitForgeFamily,
  resolveGitForgeTargets,
} from "@virgultum/embeds/provider-data";
import { ServerService } from "../../../modules/server";
import { workspaceLinkPreview } from "../../view-extensions/link-preview-service/link-preview-service";
import { EditorEmbedCardEdit } from "../../view-extensions/editor-view/editor-chrome/embed-card-edit";
import { EditorFigmaCard } from "../../view-extensions/editor-view/editor-chrome/figma-card";
import { EditorGithubCard } from "../../view-extensions/editor-view/editor-chrome/github-card";
import { EditorLoomCard } from "../../view-extensions/editor-view/editor-chrome/loom-card";
import { EditorSelectionToolbar } from "../../view-extensions/editor-view/editor-chrome/selection-toolbar";
import { EditorYoutubeCard } from "../../view-extensions/editor-view/editor-chrome/youtube-card";
import {
  convertCardBlockToInlineLink,
  copyOrCutPageBlock,
  deletePageBlock,
  duplicatePageBlock,
  leaveAtomicPageBlock,
  notifyCopied,
  pasteAfterPageBlock,
} from "./page-block-actions";
import { usePageFloatingAnchor } from "./page-floating-anchor";

type Model = EmbedLoomModel | EmbedYoutubeModel | EmbedFigmaModel;
type Props<T> = {
  model: T;
  readonly: boolean;
};
export function HtmlCard({ model, readonly }: Props<EmbedHtmlModel>) {
  const caption = usePageCaption(model, readonly);
  const t = useI18n(),
    framework = useFramework(),
    blockRef = useRef<HTMLDivElement>(null),
    wrap = useRef<HTMLDivElement>(null),
    [selected, setSelected] = useState(false),
    [anchor, setAnchor] = useState<HTMLElement | null>(null),
    [floating, setFloating] = useState<HTMLElement | null>(null),
    [active, setActive] = useState(false),
    [full, setFull] = useState(false);
  const writable = () =>
    !readonly &&
    !model.store.readonly &&
    model.store.getModelById(model.id) === model;
  usePageFloatingAnchor({
    active: selected,
    reference: blockRef.current,
    anchor,
    floating,
    onDismiss: () => setSelected(false),
  });
  useEffect(() => {
    const update = () => setFull(document.fullscreenElement === wrap.current);
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);
  const fullscreen = () => {
    void (
      document.fullscreenElement === wrap.current
        ? document.exitFullscreen()
        : wrap.current?.requestFullscreen()
    )?.catch(console.error);
  };
  const select = () => {
    if (readonly || model.store.readonly) setActive(true);
    else {
      setSelected(true);
      blockRef.current?.focus({ preventScroll: true });
    }
  };
  const toolbarState: EditorSelectionState = {
    open: selected && !readonly,
    key: model.id,
    placement: "top",
    primary: [
      {
        id: "interact",
        label: t["com.myoxus.editor.toolbar.preview"](),
        icon: "PresentationIcon",
        disabled: false,
        active,
        run: () => {
          setActive((prev) => !prev);
          setSelected(false);
        },
      },
      {
        id: "caption",
        label: t["com.myoxus.editor.toolbar.caption"](),
        icon: "CaptionIcon",
        disabled: false,
        run: caption.show,
      },
    ],
    more: [
      {
        id: "copy",
        label: t["Copy"](),
        icon: "CopyIcon",
        disabled: false,
        run: () => {
          const abort = new AbortController();
          void copyOrCutPageBlock(model, "copy", framework, abort.signal)
            .then(() => notifyCopied(t["Copied to clipboard"]()))
            .catch(console.error);
          setSelected(false);
        },
      },
      {
        id: "duplicate",
        label: t["com.myoxus.editor.keyboard.duplicate"](),
        icon: "DuplicateIcon",
        disabled: false,
        run: () => {
          duplicatePageBlock(model);
          setSelected(false);
        },
      },
      {
        id: "delete",
        label: t["Delete"](),
        icon: "DeleteIcon",
        variant: "destructive",
        disabled: false,
        run: () => {
          deletePageBlock(model);
          setSelected(false);
        },
      },
    ],
  };
  return (
    <div
      ref={blockRef}
      data-page-html=""
      data-block-id={model.id}
      contentEditable={false}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          setSelected(false);
          return;
        }
        if (e.target !== blockRef.current || !writable()) return;
        if (
          ["Delete", "Backspace", "Enter", "ArrowDown", "ArrowUp"].includes(
            e.key,
          )
        ) {
          e.preventDefault();
          leaveAtomicPageBlock(
            blockRef.current.closest<HTMLElement>("[data-page-renderer]"),
            model,
            e.key === "ArrowUp" || e.key === "Backspace" ? -1 : 1,
            e.key === "Delete" || e.key === "Backspace",
            e.key === "Enter",
          );
        }
      }}
    >
      <div style={{ height: EMBED_CARD_HEIGHT.html }}>
        <ReferenceCard
          size="preview"
          contained
          fullHeight
          orientation="vertical"
          icon={<FileIconHtmlIcon />}
          title={t["com.myoxus.editor.embed.html-title"]()}
          onDoubleClick={fullscreen}
          preview={
            model.props.html ? (
              <Box ref={wrap} h="100%" pos="relative">
                <iframe
                  title="HTML"
                  sandbox="allow-scripts"
                  loading="lazy"
                  scrolling="no"
                  width="100%"
                  height="100%"
                  srcDoc={`<style>body{margin:0}</style>${model.props.html}`}
                />
                {!active && !full && (
                  <Box pos="absolute" inset={0} onClick={select} />
                )}
                <div data-html-fullscreen="">
                  <IconButton
                    icon={<ExpandIcon />}
                    tooltip={t[
                      "com.myoxus.workbench.split-view-menu.full-screen"
                    ]()}
                    onClick={fullscreen}
                  />
                </div>
              </Box>
            ) : (
              t["com.myoxus.editor.embed.empty"]()
            )
          }
        />
      </div>
      {caption.field}
      {selected && !readonly ? (
        <EditorSelectionToolbar
          controls={{
            getSnapshot: () => toolbarState,
            subscribe: () => () => {},
            setAnchor,
            setFloating,
            activate: () => blockRef.current?.focus({ preventScroll: true }),
            dismiss: () => setSelected(false),
          }}
        />
      ) : null}
    </div>
  );
}
export function ForgeCard({ model, readonly }: Props<EmbedGithubModel>) {
  const caption = usePageCaption(model, readonly);
  const t = useI18n(),
    framework = useFramework(),
    blockRef = useRef<HTMLDivElement>(null),
    [selected, setSelected] = useState(false),
    [editing, setEditing] = useState(false),
    [anchor, setAnchor] = useState<HTMLElement | null>(null),
    [floating, setFloating] = useState<HTMLElement | null>(null),
    base = useService(ServerService).server.baseUrl;
  const writable = () =>
    !readonly &&
    !model.store.readonly &&
    model.store.getModelById(model.id) === model;
  usePageFloatingAnchor({
    active: selected || editing,
    reference: blockRef.current,
    anchor,
    floating,
    onDismiss: () => {
      setSelected(false);
      setEditing(false);
    },
  });
  const preview = useMemo(
    () => workspaceLinkPreview(base, LinkPreviewCache.getInstance()),
    [base],
  );
  const { url, style } = model.props;
  const prev = useRef(url),
    [snap, setSnap] = useState<{
      url: string;
      loading: boolean;
      reset: boolean;
      data: Partial<EmbedGithubBlockUrlData>;
    }>();
  const identity = parseGitForgeUrl(url);
  useEffect(() => {
    const replaced = prev.current !== url;
    prev.current = url;
    const abort = new AbortController(),
      fresh = () =>
        !abort.signal.aborted &&
        model.store.getModelById(model.id) === model &&
        model.props.url === url;
    const id = parseGitForgeUrl(url),
      write = () => !readonly && !model.store.readonly;
    const empty = {
      status: null,
      statusReason: null,
      assignees: null,
      title: null,
      description: null,
      createdAt: null,
      image: null,
    };
    if (
      write() &&
      (replaced ||
        (id &&
          Object.entries(id).some(
            ([k, v]) => Reflect.get(model.props, k) !== v,
          )))
    )
      model.store.withoutTransact(() =>
        model.store.updateBlock(model, {
          ...(replaced ? empty : {}),
          ...(id ?? { owner: "", repo: "", githubId: "", githubType: "issue" }),
        }),
      );
    const all = replaced || (!model.props.title && !model.props.description);
    setSnap({ url, reset: replaced, loading: all, data: {} });
    const query = all
      ? queryEmbedGithubData(model, preview, abort.signal)
      : queryEmbedGithubApiData(model, abort.signal);
    void query
      .then((data) => {
        if (!fresh()) return;
        const patch = all
          ? { ...empty, ...data }
          : data.status
            ? {
                status: data.status,
                statusReason: data.statusReason,
                createdAt: data.createdAt,
                assignees: data.assignees,
              }
            : {};
        // Editable cards follow the live model after a refresh; retaining a
        // second snapshot here would mask metadata changes made by a peer.
        if (write()) {
          if (
            Object.entries(patch).some(
              ([k, v]) =>
                JSON.stringify(Reflect.get(model.props, k)) !==
                JSON.stringify(v),
            )
          )
            model.store.updateBlock(model, patch);
          setSnap({ url, loading: false, reset: false, data: {} });
        } else setSnap({ url, loading: false, reset: replaced, data: patch });
      })
      .catch(() => {
        if (fresh())
          setSnap({ url, loading: false, reset: replaced, data: {} });
      });
    return () => abort.abort();
  }, [url, model, preview, readonly]);
  const target = resolveGitForgeTargets(url),
    current = snap?.url === url ? snap : undefined;
  const content = {
    ...(current?.reset || prev.current !== url ? {} : model.props),
    ...current?.data,
  };
  const opened = (value: string) => {
    const u = normalizeUrl(value);
    if (u && isValidUrl(u)) window.open(u, "_blank", "noopener,noreferrer");
  };
  return (
    <div
      ref={blockRef}
      data-page-forge=""
      data-block-id={model.id}
      tabIndex={-1}
      contentEditable={false}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          setSelected(false);
          setEditing(false);
          return;
        }
        if (e.target !== blockRef.current || !writable()) return;
        if (
          ["Delete", "Backspace", "Enter", "ArrowDown", "ArrowUp"].includes(
            e.key,
          )
        ) {
          e.preventDefault();
          leaveAtomicPageBlock(
            blockRef.current.closest<HTMLElement>("[data-page-renderer]"),
            model,
            e.key === "ArrowUp" || e.key === "Backspace" ? -1 : 1,
            e.key === "Delete" || e.key === "Backspace",
            e.key === "Enter",
          );
        }
      }}
      onCopy={(e) => {
        if (document.activeElement !== blockRef.current) return;
        e.preventDefault();
        const abort = new AbortController();
        void copyOrCutPageBlock(model, "copy", framework, abort.signal).catch(
          console.error,
        );
      }}
      onCut={(e) => {
        if (document.activeElement !== blockRef.current || !writable()) return;
        e.preventDefault();
        const abort = new AbortController();
        void copyOrCutPageBlock(model, "cut", framework, abort.signal).catch(
          console.error,
        );
      }}
      onPaste={(e) => {
        if (document.activeElement !== blockRef.current || !writable()) return;
        e.preventDefault();
        void pasteAfterPageBlock(model, e.clipboardData).catch(console.error);
      }}
    >
      <EditorGithubCard
        controls={{
          inSurface: false,
          selected,
          style,
          family: resolveGitForgeFamily(url),
          host: target?.host ?? parseCardUrl(url)?.host ?? "",
          repository: identity ? `${identity.owner}/${identity.repo}` : "",
          date: formatForgeCardDate(content.createdAt, t.language),
          title: content.title ?? null,
          description: content.description ?? null,
          image: content.image
            ? buildImageProxyURL(
                content.image,
                new URL(BUILD_CONFIG.imageProxyUrl, base).href,
              )
            : null,
          loading: !!current?.loading,
          type: identity?.githubType ?? "issue",
          status: content.status ?? null,
          statusReason: content.statusReason ?? null,
          assignees: content.assignees ?? null,
          open: () => opened(url),
          openAssignee: (who) => {
            if (target)
              opened(`${target.profileOrigin}/${encodeURIComponent(who)}`);
          },
          select: () => {
            if (!readonly && !model.store.readonly) {
              setSelected(true);
              blockRef.current?.focus({ preventScroll: true });
            }
          },
        }}
      />
      {caption.field}
      {selected && !editing && !readonly ? (
        <EditorSelectionToolbar
          controls={{
            getSnapshot: (): EditorSelectionState => ({
              open: true,
              key: model.id,
              placement: "top",
              primary: [
                {
                  id: "open-url",
                  label: url,
                  icon: "LinkIcon",
                  showLabel: true,
                  disabled: false,
                  run: () => opened(url),
                },
                {
                  id: "copy-link",
                  label: t["com.myoxus.editor.toolbar.copy-link"](),
                  icon: "CopyIcon",
                  disabled: false,
                  run: () => {
                    void copyTextToClipboard(url);
                    notifyCopied(t["Copied to clipboard"]());
                    setSelected(false);
                  },
                },
                {
                  id: "edit",
                  label: t["com.myoxus.editor.toolbar.edit-description"](),
                  icon: "EditIcon",
                  disabled: false,
                  run: () => setEditing(true),
                },
                {
                  id: "caption",
                  label: t["com.myoxus.editor.toolbar.caption"](),
                  icon: "CaptionIcon",
                  disabled: false,
                  run: caption.show,
                },
              ],
              more: [
                {
                  id: "inline",
                  label: t["com.myoxus.editor.toolbar.inline-view"](),
                  icon: "LinkIcon",
                  disabled: false,
                  run: () => {
                    convertCardBlockToInlineLink(model, url, content.title);
                    setSelected(false);
                  },
                },
                {
                  id: "duplicate",
                  label: t["com.myoxus.editor.keyboard.duplicate"](),
                  icon: "DuplicateIcon",
                  disabled: false,
                  run: () => {
                    duplicatePageBlock(model);
                    setSelected(false);
                  },
                },
                {
                  id: "delete",
                  label: t["Delete"](),
                  icon: "DeleteIcon",
                  variant: "destructive",
                  disabled: false,
                  run: () => {
                    deletePageBlock(model);
                    setSelected(false);
                  },
                },
              ] satisfies SelectionAction[],
            }),
            subscribe: () => () => {},
            setAnchor,
            setFloating,
            activate: () => blockRef.current?.focus({ preventScroll: true }),
            dismiss: () => setSelected(false),
          }}
        />
      ) : null}
      {editing && !readonly ? (
        <EditorEmbedCardEdit
          controls={{
            mode: "external",
            internal: false,
            title: model.props.title ?? "",
            description: model.props.description ?? "",
            canReset: false,
            reset: () => {},
            setAnchor,
            confirm: (nextTitle, nextDescription) => {
              if (writable()) {
                model.store.captureSync();
                model.store.updateBlock(model, {
                  title: nextTitle.trim() || null,
                  description: nextDescription.trim() || null,
                });
                model.store.captureSync();
              }
              setEditing(false);
            },
            close: () => setEditing(false),
          }}
        />
      ) : null}
    </div>
  );
}
export function PageIframe({
  model,
  readonly,
}: {
  model: EmbedIframeBlockModel;
  readonly: boolean;
}) {
  const t = useI18n();
  const framework = useFramework();
  const caption = usePageCaption(model, readonly);
  const service = model.store.get(EmbedIframeService);
  const base = useService(ServerService).server.baseUrl;
  const blockRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState(false);
  const [editingUrl, setEditingUrl] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [floating, setFloating] = useState<HTMLElement | null>(null);
  const writable = () =>
    !readonly &&
    !model.store.readonly &&
    model.store.getModelById(model.id) === model;
  usePageFloatingAnchor({
    active: selected || editingUrl,
    reference: blockRef.current,
    anchor,
    floating,
    onDismiss: () => {
      setSelected(false);
      setEditingUrl(false);
    },
  });
  const preview = useMemo(
    () => workspaceLinkPreview(base, LinkPreviewCache.getInstance()),
    [base],
  );
  const { url, iframeUrl } = model.props,
    config = url ? service.getConfig(url) : undefined,
    options = config?.options;
  const prev = useRef(url);
  const [retry, setRetry] = useState(0),
    [interactive, setInteractive] = useState(false);
  const [answer, setAnswer] = useState<{
    url: string;
    src?: string;
    error?: boolean;
  }>();
  useEffect(() => {
    const changed = prev.current !== url;
    prev.current = url;
    setInteractive(false);
    if (!url) return;
    if (!changed && !retry && iframeUrl) {
      setAnswer({ url, src: iframeUrl });
      return;
    }
    const abort = new AbortController();
    const live = () =>
      !abort.signal.aborted &&
      model.store.getModelById(model.id) === model &&
      model.props.url === url;
    setAnswer(undefined);
    void Promise.all([
      service.getEmbedIframeData(url, abort.signal),
      preview.query(url, abort.signal),
    ])
      .then(([data, meta]) => {
        if (!live()) return;
        const src =
          data?.iframe_url ?? (data?.html && safeGetIframeSrc(data.html));
        if (!src) {
          setAnswer({ url, error: true });
          return;
        }
        setAnswer({ url, src });
        if (!readonly && !model.store.readonly)
          model.store.updateBlock(model, {
            iframeUrl: src,
            title: data?.title || meta.title,
            description: data?.description || meta.description,
          });
      })
      .catch(() => {
        if (live()) setAnswer({ url, error: true });
      });
    return () => abort.abort();
  }, [model, preview, service, url, retry, iframeUrl, readonly]);
  const state = answer?.url === url ? answer : undefined;
  const src =
    state?.src && URL.canParse(state.src) ? new URL(state.src) : undefined;
  const usable =
    src?.protocol === "https:" && !!config && service.canEmbed(src.href);
  const select = (control?: string) => {
    if (readonly || model.store.readonly) {
      setInteractive(true);
      return;
    }
    blockRef.current?.focus({ preventScroll: true });
    if (control === "iframe-input") {
      setEditingUrl(true);
      setSelected(false);
    } else {
      setSelected(true);
    }
  };
  return (
    <div
      ref={blockRef}
      data-block-id={model.id}
      contentEditable={false}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          setSelected(false);
          setEditingUrl(false);
          return;
        }
        if (e.target !== blockRef.current || !writable()) return;
        if (
          ["Delete", "Backspace", "Enter", "ArrowDown", "ArrowUp"].includes(
            e.key,
          )
        ) {
          e.preventDefault();
          leaveAtomicPageBlock(
            blockRef.current.closest<HTMLElement>("[data-page-renderer]"),
            model,
            e.key === "ArrowUp" || e.key === "Backspace" ? -1 : 1,
            e.key === "Delete" || e.key === "Backspace",
            e.key === "Enter",
          );
        }
      }}
    >
      <div
        data-page-iframe=""
        onClick={() => select(!url ? "iframe-input" : undefined)}
        style={{
          position: "relative",
          borderRadius: options?.containerBorderRadius,
        }}
      >
        {usable && src ? (
          <>
            <iframe
              key={src.href}
              src={src.href}
              title={model.props.title || new URL(url).hostname}
              ref={(el) => {
                if (el && options?.style) el.style.cssText = options.style;
              }}
              sandbox={iframeSandbox(
                service.getConfig(src.href)?.name === config?.name
                  ? config
                  : undefined,
              )}
              loading="lazy"
              {...{ credentialless: true }}
              width={`${options?.widthPercent ?? 100}%`}
              height={options?.heightInNote ?? 152}
              allowFullScreen={options?.allowFullscreen}
              allow={options?.allow}
              referrerPolicy={
                options?.referrerpolicy as ReferrerPolicy | undefined
              }
              scrolling={
                options?.scrolling === undefined
                  ? undefined
                  : options.scrolling
                    ? "yes"
                    : "no"
              }
            />
            <span data-iframe-source="">{new URL(url).hostname}</span>
            {!interactive && <div data-iframe-guard="" />}
          </>
        ) : (
          <EditorIframeStatusCard
            controls={{
              status: !url
                ? "idle"
                : state?.error || state?.src
                  ? "error"
                  : "loading",
              message: url,
              inSurface: false,
              selected: false,
              readonly,
              edit: () => select("iframe-input"),
              retry: async () => setRetry((n) => n + 1),
            }}
          />
        )}
      </div>
      {caption.field}
      {selected && !editingUrl && !readonly ? (
        <EditorSelectionToolbar
          controls={{
            getSnapshot: (): EditorSelectionState => ({
              open: true,
              key: model.id,
              placement: "top",
              primary: [
                ...(url
                  ? [
                      {
                        id: "open-url",
                        label: url,
                        icon: "LinkIcon" as const,
                        showLabel: true,
                        disabled: false,
                        run: () => {
                          const link = normalizeUrl(url);
                          if (isValidUrl(link))
                            window.open(link, "_blank", "noopener,noreferrer");
                        },
                      },
                    ]
                  : []),
                {
                  id: "edit-url",
                  label: t["com.myoxus.editor.toolbar.edit-description"](),
                  icon: "EditIcon",
                  disabled: false,
                  run: () => setEditingUrl(true),
                },
                {
                  id: "interact",
                  label: t["com.myoxus.editor.toolbar.preview"](),
                  icon: "PresentationIcon",
                  disabled: !usable,
                  active: interactive,
                  run: () => {
                    setInteractive((prev) => !prev);
                    setSelected(false);
                  },
                },
                {
                  id: "caption",
                  label: t["com.myoxus.editor.toolbar.caption"](),
                  icon: "CaptionIcon",
                  disabled: false,
                  run: caption.show,
                },
              ],
              more: [
                {
                  id: "reload",
                  label: t["com.myoxus.editor.toolbar.reload"](),
                  icon: "ResetIcon",
                  disabled: !url,
                  run: () => setRetry((n) => n + 1),
                },
                {
                  id: "copy",
                  label: t["Copy"](),
                  icon: "CopyIcon",
                  disabled: false,
                  run: () => {
                    const abort = new AbortController();
                    void copyOrCutPageBlock(
                      model,
                      "copy",
                      framework,
                      abort.signal,
                    )
                      .then(() => notifyCopied(t["Copied to clipboard"]()))
                      .catch(console.error);
                    setSelected(false);
                  },
                },
                {
                  id: "duplicate",
                  label: t["com.myoxus.editor.keyboard.duplicate"](),
                  icon: "DuplicateIcon",
                  disabled: false,
                  run: () => {
                    duplicatePageBlock(model);
                    setSelected(false);
                  },
                },
                {
                  id: "delete",
                  label: t["Delete"](),
                  icon: "DeleteIcon",
                  variant: "destructive",
                  disabled: false,
                  run: () => {
                    deletePageBlock(model);
                    setSelected(false);
                  },
                },
              ],
            }),
            subscribe: () => () => {},
            setAnchor,
            setFloating,
            activate: () => blockRef.current?.focus({ preventScroll: true }),
            dismiss: () => setSelected(false),
          }}
        />
      ) : null}
      {editingUrl && !readonly ? (
        <EditorIframeLinkEditor
          controls={{
            editing: Boolean(url),
            showCloseButton: true,
            setAnchor,
            confirm: async (raw) => {
              const nextUrl = normalizeUrl(raw.trim());
              if (writable() && isValidUrl(nextUrl)) {
                model.store.captureSync();
                model.store.updateBlock(model, { url: nextUrl, iframeUrl: "" });
                model.store.captureSync();
              }
              setEditingUrl(false);
            },
            close: () => setEditingUrl(false),
          }}
        />
      ) : null}
    </div>
  );
}
export default function PageProviderPlayer({
  model,
  readonly,
}: {
  model: Model;
  readonly: boolean;
}) {
  const t = useI18n();
  const framework = useFramework();
  const caption = usePageCaption(model, readonly);
  const blockRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState(false);
  const [editing, setEditing] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [floating, setFloating] = useState<HTMLElement | null>(null);
  const base = useService(ServerService).server.baseUrl;
  const writable = () =>
    !readonly &&
    !model.store.readonly &&
    model.store.getModelById(model.id) === model;
  const preview = useMemo(
    () => workspaceLinkPreview(base, LinkPreviewCache.getInstance()),
    [base],
  );
  const proxy = (value?: string | null) =>
    value
      ? buildImageProxyURL(
          value,
          new URL(BUILD_CONFIG.imageProxyUrl, base).href,
        )
      : null;
  const { url, title, description, style } = model.props;
  const previous = useRef<string>(undefined),
    [snapshot, setSnapshot] = useState<{
      url: string;
      loading: boolean;
      replaced?: boolean;
      data?: Partial<EmbedYoutubeBlockUrlData>;
    }>();
  const video =
    model instanceof EmbedLoomModel || model instanceof EmbedYoutubeModel;
  const id = video
    ? (url.match(
        model instanceof EmbedLoomModel ? loomUrlRegex : youtubeUrlRegex,
      )?.[1] ?? (!url ? model.props.videoId : null))
    : null;
  const [print, setPrint] = useState(() => window.matchMedia("print").matches);
  const [reading, setReading] = useState(false);
  useEffect(() => {
    if (!(model instanceof EmbedYoutubeModel)) return;
    const m = window.matchMedia("print"),
      refresh = () => setPrint(m.matches);
    m.addEventListener("change", refresh);
    return () => m.removeEventListener("change", refresh);
  }, [model]);
  useEffect(() => {
    const changed = previous.current !== undefined && previous.current !== url;
    previous.current = url;
    setReading(false);
    if (!video) return;
    const writable = () => !readonly && !model.store.readonly;
    if ((changed || id !== model.props.videoId) && writable())
      model.store.withoutTransact(() =>
        model.store.updateBlock(model, {
          videoId: id,
          ...(changed
            ? {
                title: null,
                description: null,
                image: null,
                ...(model instanceof EmbedYoutubeModel
                  ? { creator: null, creatorImage: null, creatorUrl: null }
                  : {}),
              }
            : {}),
        }),
      );
    if (!changed && (model.props.title || model.props.description)) return;
    const abort = new AbortController(),
      live = () =>
        !abort.signal.aborted &&
        model.store.getModelById(model.id) === model &&
        model.props.url === url;
    setSnapshot({ url, loading: true, replaced: changed });
    const query =
      model instanceof EmbedLoomModel
        ? queryEmbedLoomData(model, abort.signal)
        : queryEmbedYoutubeData(model, preview, abort.signal);
    void query
      .then((data) => {
        if (!live()) return;
        setSnapshot({
          url,
          loading: false,
          replaced: changed && !writable(),
          data: writable() ? undefined : data,
        });
        if (writable() && Object.keys(data).length)
          model.store.updateBlock(model, data);
      })
      .catch(() => {
        if (live())
          setSnapshot({
            url,
            loading: false,
            replaced: changed && !writable(),
          });
      });
    return () => abort.abort();
  }, [model, video, id, preview, url, readonly]);
  const current = snapshot?.url === url ? snapshot : undefined;
  const stored =
    !current?.replaced &&
    (previous.current === undefined || previous.current === url);
  const common = {
    url,
    description:
      current?.data?.description ?? (stored ? description : null) ?? null,
    selected: reading || selected,
    showOverlay: !reading,
    open: () => {
      const link = normalizeUrl(model.props.url);
      if (isValidUrl(link)) window.open(link, "_blank", "noopener,noreferrer");
    },
    select: (event: MouseEvent) => {
      event.stopPropagation();
      if (readonly || model.store.readonly) setReading(true);
      else {
        setSelected(true);
        blockRef.current?.focus({ preventScroll: true });
      }
    },
  };
  usePageFloatingAnchor({
    active: selected || editing,
    reference: blockRef.current,
    anchor,
    floating,
    onDismiss: () => {
      setSelected(false);
      setEditing(false);
    },
  });
  const data = {
    ...common,
    title: current?.data?.title ?? (stored ? title : null),
    loading: !!current?.loading,
    videoId: id ?? null,
    image: proxy(
      current?.data?.image ?? (video && stored ? model.props.image : null),
    ),
  };
  return (
    <div
      ref={blockRef}
      data-block-id={model.id}
      data-page-provider={model.flavour}
      tabIndex={-1}
      contentEditable={false}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          setSelected(false);
          setEditing(false);
          return;
        }
        if (e.target !== blockRef.current || !writable()) return;
        if (
          ["Delete", "Backspace", "Enter", "ArrowDown", "ArrowUp"].includes(
            e.key,
          )
        ) {
          e.preventDefault();
          leaveAtomicPageBlock(
            blockRef.current.closest<HTMLElement>("[data-page-renderer]"),
            model,
            e.key === "ArrowUp" || e.key === "Backspace" ? -1 : 1,
            e.key === "Delete" || e.key === "Backspace",
            e.key === "Enter",
          );
        }
      }}
      onCopy={(e) => {
        if (document.activeElement !== blockRef.current) return;
        e.preventDefault();
        const abort = new AbortController();
        void copyOrCutPageBlock(model, "copy", framework, abort.signal).catch(
          console.error,
        );
      }}
      onCut={(e) => {
        if (document.activeElement !== blockRef.current || !writable()) return;
        e.preventDefault();
        const abort = new AbortController();
        void copyOrCutPageBlock(model, "cut", framework, abort.signal).catch(
          console.error,
        );
      }}
      onPaste={(e) => {
        if (document.activeElement !== blockRef.current || !writable()) return;
        e.preventDefault();
        void pasteAfterPageBlock(model, e.clipboardData).catch(console.error);
      }}
    >
      <div style={{ height: EMBED_CARD_HEIGHT[style] }}>
        {model instanceof EmbedLoomModel ? (
          <EditorLoomCard controls={{ ...data, title: data.title ?? "Loom" }} />
        ) : model instanceof EmbedYoutubeModel ? (
          <EditorYoutubeCard
            controls={{
              ...data,
              title: data.title ?? "YouTube",
              printImage: print,
              creator:
                current?.data?.creator ?? (stored ? model.props.creator : null),
              creatorImage: proxy(
                current?.data?.creatorImage ??
                  (stored ? model.props.creatorImage : null),
              ),
            }}
          />
        ) : (
          <EditorFigmaCard
            controls={{
              ...common,
              title: title ?? "Figma",
              iframeUrl: `https://www.figma.com/embed?embed_host=virgultum&url=${encodeURIComponent(url)}`,
            }}
          />
        )}
      </div>
      {caption.field}
      {selected && !editing && !readonly ? (
        <EditorSelectionToolbar
          controls={{
            getSnapshot: (): EditorSelectionState => ({
              open: true,
              key: model.id,
              placement: "top",
              primary: [
                {
                  id: "open-url",
                  label: url,
                  icon: "LinkIcon",
                  showLabel: true,
                  disabled: false,
                  run: common.open,
                },
                {
                  id: "copy-link",
                  label: t["com.myoxus.editor.toolbar.copy-link"](),
                  icon: "CopyIcon",
                  disabled: false,
                  run: () => {
                    void copyTextToClipboard(normalizeUrl(url));
                    notifyCopied(t["Copied to clipboard"]());
                    setSelected(false);
                  },
                },
                {
                  id: "edit",
                  label: t["com.myoxus.editor.toolbar.edit-description"](),
                  icon: "EditIcon",
                  disabled: false,
                  run: () => setEditing(true),
                },
                {
                  id: "interact",
                  label: t["com.myoxus.editor.toolbar.preview"](),
                  icon: "PresentationIcon",
                  disabled: false,
                  active: reading,
                  run: () => {
                    setReading((prev) => !prev);
                    setSelected(false);
                  },
                },
                {
                  id: "caption",
                  label: t["com.myoxus.editor.toolbar.caption"](),
                  icon: "CaptionIcon",
                  disabled: false,
                  run: caption.show,
                },
              ],
              more: [
                {
                  id: "inline",
                  label: t["com.myoxus.editor.toolbar.inline-view"](),
                  icon: "LinkIcon",
                  disabled: false,
                  run: () => {
                    convertCardBlockToInlineLink(model, url, title);
                    setSelected(false);
                  },
                },
                {
                  id: "duplicate",
                  label: t["com.myoxus.editor.keyboard.duplicate"](),
                  icon: "DuplicateIcon",
                  disabled: false,
                  run: () => {
                    duplicatePageBlock(model);
                    setSelected(false);
                  },
                },
                {
                  id: "delete",
                  label: t["Delete"](),
                  icon: "DeleteIcon",
                  variant: "destructive",
                  disabled: false,
                  run: () => {
                    deletePageBlock(model);
                    setSelected(false);
                  },
                },
              ],
            }),
            subscribe: () => () => {},
            setAnchor,
            setFloating,
            activate: () => blockRef.current?.focus({ preventScroll: true }),
            dismiss: () => setSelected(false),
          }}
        />
      ) : null}
      {editing && !readonly ? (
        <EditorEmbedCardEdit
          controls={{
            mode: "external",
            internal: false,
            title: title ?? "",
            description: description ?? "",
            canReset: false,
            reset: () => {},
            setAnchor,
            confirm: (nextTitle, nextDescription) => {
              if (writable()) {
                model.store.captureSync();
                model.store.updateBlock(model, {
                  title: nextTitle.trim() || null,
                  description: nextDescription.trim() || null,
                });
                model.store.captureSync();
              }
              setEditing(false);
            },
            close: () => setEditing(false),
          }}
        />
      ) : null}
    </div>
  );
}
