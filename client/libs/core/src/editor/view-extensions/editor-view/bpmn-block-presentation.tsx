// SPDX-License-Identifier: AGPL-3.0-or-later
import { useI18n } from "@myoxus/i18n";
import { prepareBpmnPreviewSvg } from "@myoxus/bpmn-editor/preview";
import { BRANDING_STYLE_ID } from "@myoxus/theme";
import type { MountReactPortal } from "@myoxus/core/editor/portal";
import {
  Button,
  Card,
  Group,
  Menu,
  MenuItem,
  MyoxusTextInput,
  Stack,
  Text,
  notify,
  MediaPreviewImage,
  useResolvedDomTheme,
} from "@myoxus/ui-facade";
import { MyoxusEmbeddedUIProvider } from "@myoxus/ui-facade/provider";
import {
  BpmnBlockPresentationExtension,
  type BpmnBlockPresentationProps,
  type BpmnBlockPresentationBinding,
} from "@virgultum/block-bpmn";
import {
  type PropsWithChildren,
  useCallback,
  useEffect,
  useState,
  useRef,
  createContext,
  useContext,
  useMemo,
  useId,
  useLayoutEffect,
  useSyncExternalStore,
} from "react";
import { materializeDiagramExportSvg } from "../../../components/hooks/myoxus/diagram-export-svg";
import type { DocFrontend, DocFrontendDocState } from "@myoxus/storage";
export type PreviewDocStorage = Pick<
  DocFrontend,
  "docState$" | "waitForSynced"
>;
const PreviewProjection = createContext<{
  root: HTMLElement;
  scheme: string | undefined;
} | null>(null);

function themeScope(root: Element): Element | null {
  let current: Element | null = root;
  while (current) {
    const found = current.closest("[data-theme='light'], [data-theme='dark']");
    if (found) return found;
    const tree = current.getRootNode();
    current = tree instanceof ShadowRoot ? tree.host : null;
  }
  return null;
}
/** Same portal/provider boundary as the existing Mermaid host; no standalone React root. */
function BpmnEmbeddedUIRoot({
  children,
  root,
}: PropsWithChildren<{ root: HTMLElement }>) {
  const resolve = useCallback((): "light" | "dark" | undefined => {
    const value = themeScope(root)?.getAttribute("data-theme");
    return value === "dark" || value === "light" ? value : undefined;
  }, [root]);
  const [scheme, setScheme] = useState(resolve);
  const projection = useMemo(() => ({ root, scheme }), [root, scheme]);
  const id = useId();
  const selector = `[data-myoxus-bpmn-react-root="${id}"]`;
  useLayoutEffect(() => {
    root.setAttribute("data-myoxus-bpmn-react-root", id);
    return () => root.removeAttribute("data-myoxus-bpmn-react-root");
  }, [root, id]);
  const getRootElement = useCallback(() => root, [root]);
  useEffect(() => {
    const scope = themeScope(root);
    if (!scope) return;
    const observer = new MutationObserver(() => setScheme(resolve()));
    observer.observe(scope, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, [root, resolve]);
  return (
    <MyoxusEmbeddedUIProvider
      colorScheme={scheme}
      cssVariablesSelector={selector}
      getRootElement={getRootElement}
    >
      <PreviewProjection.Provider value={projection}>
        {children}
      </PreviewProjection.Provider>
    </MyoxusEmbeddedUIProvider>
  );
}

export function BpmnBlockPresentation(
  props: BpmnBlockPresentationProps & {
    docStorage: PreviewDocStorage;
    projectionRoot?: HTMLElement | null;
  },
) {
  const t = useI18n();
  const [pending, setPending] = useState(false);
  const [sync, setSync] = useState<DocFrontendDocState | null>(null);
  const synced = sync?.synced;
  const [confirmedRevision, setConfirmedRevision] = useState<string | null>(
    null,
  );
  useEffect(() => {
    const subscription = props.docStorage
      .docState$(props.docId)
      .subscribe(setSync);
    return () => subscription.unsubscribe();
  }, [props.docStorage, props.docId]);
  useEffect(() => {
    if (!props.sourceRevision || synced === undefined) return;
    const lifetime = new AbortController();
    const signal = AbortSignal.any([
      lifetime.signal,
      AbortSignal.timeout(30_000),
    ]);
    // A throttled generic sync status may still describe the previous head.
    // Confirm this selected revision independently; late ACKs retain their key.
    void props.docStorage.waitForSynced(props.docId, signal).then(
      () => {
        if (!signal.aborted) setConfirmedRevision(props.sourceRevision);
      },
      () => {
        /* Locally durable output stays pending; a reconnect retries. */
      },
    );
    return () => lifetime.abort();
  }, [props.docStorage, props.docId, props.sourceRevision, synced]);
  const theme = useResolvedDomTheme();
  const projection = useContext(PreviewProjection);
  const [fontEpoch, setFontEpoch] = useState(0);
  const [image, setImage] = useState<{
    url: string;
    sourceId: string;
    revision: string;
    theme: string;
  } | null>(null);
  const [imageError, setImageError] = useState(false);
  const [imageLoading, setImageLoading] = useState(!!props.preview);
  const liveUrl = useRef<string | null>(null);
  const loadPreview = useRef(props.loadPreview);
  loadPreview.current = props.loadPreview;
  const projectionRoot = projection?.root ?? props.projectionRoot ?? undefined;
  const imageTheme = `${theme}:${projection?.scheme}:${fontEpoch}`;
  useEffect(() => {
    const changed = () => setFontEpoch((value) => value + 1);
    const stylesheet = document.getElementById(BRANDING_STYLE_ID);
    const observer = new MutationObserver(changed);
    if (stylesheet)
      observer.observe(stylesheet, {
        childList: true,
        characterData: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-myoxus-branding-source"],
      });
    document.fonts?.addEventListener?.("loadingdone", changed);
    return () => {
      observer.disconnect();
      document.fonts?.removeEventListener?.("loadingdone", changed);
    };
  }, []);
  const previewId = props.preview?.sourceId,
    previewRevision = props.preview?.revision;
  // Stored bytes are re-sanitized before entering the hidden materializer. Only
  // the resulting self-contained SVG is exposed through an inert image URL.
  // Keep last-good output during replacements/failure; its key prevents a stale
  // image or theme from being presented as the current source revision.
  useEffect(() => {
    let active = true;
    const lifetime = new AbortController();
    const signal = AbortSignal.any([
      lifetime.signal,
      AbortSignal.timeout(30_000),
    ]);
    setImageError(false);
    if (!previewId || !previewRevision) {
      setImageLoading(false);
      return;
    }
    setImageLoading(true);
    const stopped = Promise.withResolvers<never>();
    const stop = () => stopped.reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    void (async () => {
      try {
        const blob = await Promise.race([
          loadPreview.current(previewId),
          stopped.promise,
        ]);
        if (!blob) throw new Error("BPMN_PREVIEW_NOT_FOUND");
        if (!active) return;
        if (
          !BUILD_CONFIG.isElectron &&
          document.getElementById(BRANDING_STYLE_ID)?.dataset
            .myoxusBrandingSource !== "api"
        )
          throw new Error("BPMN_PREVIEW_THEME_UNAVAILABLE");
        const sanitized = prepareBpmnPreviewSvg(
          await Promise.race([blob.text(), stopped.promise]),
          previewRevision,
          previewRevision,
        );
        if (!active || signal.aborted) return;
        const standalone = await materializeDiagramExportSvg(
          sanitized,
          signal,
          projectionRoot,
        );
        if (!active) return;
        const url = URL.createObjectURL(
          new Blob([standalone], { type: "image/svg+xml" }),
        );
        const previous = liveUrl.current;
        liveUrl.current = url;
        setImage({
          url,
          sourceId: previewId,
          revision: previewRevision,
          theme: imageTheme,
        });
        if (previous) URL.revokeObjectURL(previous);
      } catch {
        if (active) setImageError(true);
      } finally {
        signal.removeEventListener("abort", stop);
        if (active) setImageLoading(false);
      }
    })();
    return () => {
      active = false;
      lifetime.abort();
    };
  }, [previewId, previewRevision, imageTheme, projectionRoot]);
  useEffect(
    () => () => {
      if (liveUrl.current) URL.revokeObjectURL(liveUrl.current);
    },
    [],
  );
  const previewError =
    imageError ||
    (!!props.sourceRevision &&
      props.previewErrorRevision === props.sourceRevision);
  const currentImage =
    image?.revision === props.sourceRevision &&
    image?.sourceId === previewId &&
    image?.theme === imageTheme;
  const run = async (action: () => void | Promise<void>) => {
    if (pending) return;
    setPending(true);
    try {
      await action();
    } catch {
      notify.error(t["com.myoxus.common.operation-failed"]());
    } finally {
      setPending(false);
    }
  };
  return (
    <Card withBorder={false}>
      <Stack
        onKeyDown={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => {
          if (
            event.target instanceof HTMLImageElement &&
            event.target.dataset.myoxusUiRole === "media-preview-image"
          ) {
            void run(props.onOpen);
          }
        }}
      >
        <MyoxusTextInput
          label={t["com.myoxus.editor.bpmn.default-title"]()}
          placeholder={t["com.myoxus.editor.bpmn.default-title"]()}
          value={props.titleValue}
          disabled={props.readonly}
          onChange={props.onTitleChange}
        />
        <Group>
          <Button
            disabled={pending}
            onClick={() => {
              void run(props.onOpen);
            }}
          >
            {props.readonly
              ? t["com.myoxus.editor.edgeless-embed-synced-doc-header.open"]()
              : t.Edit()}
          </Button>
          {props.downloads.length === 1 ? (
            <Button
              variant="secondary"
              onClick={() => {
                void run(props.downloads[0].download);
              }}
            >
              {t["com.myoxus.attachment.download"]()}
            </Button>
          ) : props.downloads.length > 1 ? (
            <Menu
              items={
                <>
                  {props.downloads.map((source, index) => (
                    <MenuItem
                      key={source.revision}
                      onSelect={() => {
                        void run(source.download);
                      }}
                    >
                      {t["com.myoxus.common.version-number"]({
                        number: new Intl.NumberFormat(t.language).format(
                          index + 1,
                        ),
                      })}
                    </MenuItem>
                  ))}
                </>
              }
            >
              <Button variant="secondary">
                {t["com.myoxus.attachment.download"]()}
              </Button>
            </Menu>
          ) : null}
          {(props.sourceState !== "ready" ||
            previewError ||
            (!!image && !currentImage)) && (
            <Button
              variant="secondary"
              disabled={pending}
              onClick={() => {
                void run(async () => {
                  await props.onRetry();
                  setFontEpoch((value) => value + 1);
                });
              }}
            >
              {t.Retry()}
            </Button>
          )}
        </Group>
        {image && (
          <MediaPreviewImage
            src={image.url}
            alt={props.title}
            onError={() => setImageError(true)}
          />
        )}
        {(props.sourceState !== "ready" || previewError || !currentImage) && (
          <Text role="status">
            {props.sourceState === "conflict"
              ? t["com.myoxus.editor.bpmn.source-conflict"]()
              : props.sourceState === "error"
                ? t["com.myoxus.editor.bpmn.source-error"]()
                : image
                  ? t["com.myoxus.editor.bpmn.preview-stale"]()
                  : previewError
                    ? t["com.myoxus.common.preview-unavailable"]()
                    : imageLoading
                      ? t.Loading()
                      : t["com.myoxus.common.preview-unavailable"]()}
          </Text>
        )}
        {props.sourceState === "ready" && !previewError && currentImage && (
          <Text role="status" aria-live="polite">
            {!sync
              ? t.Loading()
              : sync.updating
                ? t["common.saving"]()
                : !sync.synced || confirmedRevision !== props.sourceRevision
                  ? t["com.myoxus.editor.bpmn.pending-sync"]()
                  : t["com.myoxus.database.view.saved"]()}
          </Text>
        )}
      </Stack>
    </Card>
  );
}

function LiveBpmnBlockPresentation({
  binding,
  docStorage,
}: {
  binding: BpmnBlockPresentationBinding;
  docStorage: PreviewDocStorage;
}) {
  const state = useSyncExternalStore(binding.subscribe, binding.getSnapshot);
  return <BpmnBlockPresentation {...state} docStorage={docStorage} />;
}

export function patchBpmnBlockPresentation(
  mountPortal: MountReactPortal,
  docStorage: PreviewDocStorage,
) {
  return BpmnBlockPresentationExtension((anchor, binding) =>
    mountPortal(
      anchor,
      <BpmnEmbeddedUIRoot root={anchor}>
        <LiveBpmnBlockPresentation binding={binding} docStorage={docStorage} />
      </BpmnEmbeddedUIRoot>,
    ),
  );
}
