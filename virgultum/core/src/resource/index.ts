import {
  computed,
  effect,
  type ReadonlySignal,
  signal,
} from "@preact/signals-core";
import type { Disposable } from "@virgultum/core/primitives/disposable";
import type { BlobEngine, BlobState } from "@virgultum/core/sync";

export type ResourceKind = "Blob" | "File" | "Image";

export type StateKind =
  "loading" | "uploading" | "error" | "error:oversize" | "none";

export type StateInfo = {
  icon?: unknown;
  title?: string;
  description?: string | null;
};

export type ResolvedStateInfoPart = {
  loading: boolean;
  error: boolean;
  state: StateKind;
  url: string | null;
  needUpload: boolean;
};

export type ResolvedStateInfo = StateInfo & ResolvedStateInfoPart;

export class ResourceController implements Disposable {
  readonly blobUrl$ = signal<string | null>(null, {
    name: "editor.resource.url",
  });

  // TODO(@fundon): default `loading` status.
  readonly state$ = signal<Partial<BlobState>>(
    {},
    { name: "editor.resource.state" },
  );

  readonly resolvedState$ = computed<ResolvedStateInfoPart>(
    () => {
      const url = this.blobUrl$.value;
      const {
        needUpload = false,
        uploading = false,
        downloading = false,
        overSize = false,
        errorMessage,
      } = this.state$.value;
      const hasExceeded = overSize;
      const hasError = hasExceeded || Boolean(errorMessage);
      const state = this.determineState(
        hasExceeded,
        hasError,
        uploading,
        downloading,
      );

      const loading = state === "uploading" || state === "loading";

      return {
        error: hasError,
        needUpload,
        loading,
        state,
        url,
      };
    },
    { name: "editor.resource.resolvedState" },
  );

  private engine?: BlobEngine;
  private revision = 0;
  private publishedFor?: string;

  constructor(
    readonly blobId$: ReadonlySignal<string | undefined>,
    readonly kind: ResourceKind = "File",
  ) {}

  // This is a tradeoff, initializing `Blob Sync Engine`.
  setEngine(engine: BlobEngine) {
    this.engine = engine;
    return this;
  }

  determineState(
    hasExceeded: boolean,
    hasError: boolean,
    uploading: boolean,
    downloading: boolean,
  ): StateKind {
    if (hasExceeded) return "error:oversize";
    if (hasError) return "error";
    if (uploading) return "uploading";
    if (downloading) return "loading";
    return "none";
  }

  resolveStateWith(
    info: {
      loadingIcon?: unknown;
      errorIcon?: unknown;
    } & StateInfo,
  ): ResolvedStateInfo {
    const { error, loading, state, url, needUpload } =
      this.resolvedState$.value;

    const { icon, title, description, loadingIcon, errorIcon } = info;

    const result = {
      error,
      loading,
      state,
      icon,
      title,
      description,
      url,
      needUpload,
    };

    if (loading) {
      result.icon = loadingIcon ?? icon;
    } else if (error) {
      result.icon = errorIcon ?? icon;
      result.description = this.state$.value.errorMessage ?? description;
    }

    return result;
  }

  updateState(state: Partial<BlobState>) {
    this.state$.value = { ...this.state$.value, ...state };
  }

  subscribe(): () => void {
    return effect(
      () => {
        const blobId = this.blobId$.value;
        if (!blobId) return;

        const blobState$ = this.engine?.blobState$(blobId);
        if (!blobState$) return;

        const subscription = blobState$.subscribe((state) => {
          let { uploading, downloading, errorMessage } = state;
          if (state.overSize) {
            uploading = false;
            downloading = false;
          } else if ((uploading || downloading) && errorMessage) {
            errorMessage = null;
          }

          this.updateState({ ...state, uploading, downloading, errorMessage });
        });

        return () => subscription.unsubscribe();
      },
      { name: "editor.resource.subscribe" },
    );
  }

  /** Blob reads cannot be cancelled by this view. Only its latest live request
   * may publish a URL or an error, including retries of the same source. */
  async refreshUrlWith(type?: string) {
    const revision = ++this.revision;
    const blobId = this.blobId$.peek();
    if (blobId !== this.publishedFor) this.releaseUrl();
    this.state$.value = {};
    if (!blobId) return;

    const current = () =>
      revision === this.revision && blobId === this.blobId$.peek();

    try {
      if (!this.engine) {
        throw new Error("Blob engine is not initialized");
      }
      const blob = await this.engine.get(blobId);
      if (!current()) return;
      if (!blob) {
        this.updateState({ errorMessage: `${this.kind} not found` });
        return;
      }
      const url = URL.createObjectURL(type ? new Blob([blob], { type }) : blob);
      const previous = this.blobUrl$.peek();
      this.publishedFor = blobId;
      this.blobUrl$.value = url;
      if (previous) URL.revokeObjectURL(previous);
    } catch (err) {
      if (!current()) return;
      console.error(err);
      this.updateState({ errorMessage: `Failed to retrieve ${this.kind}` });
    }
  }

  // Re-upload to the server.
  async upload() {
    const blobId = this.blobId$.peek();
    if (!blobId) return;

    const state = this.state$.peek();
    if (!state.needUpload) return;
    if (state.uploading) return;

    // Resets the state.
    this.state$.value = {};

    return await this.engine?.upload(blobId);
  }

  private releaseUrl() {
    const url = this.blobUrl$.peek();
    this.publishedFor = undefined;
    this.blobUrl$.value = null;
    if (url) URL.revokeObjectURL(url);
  }

  dispose() {
    ++this.revision;
    this.releaseUrl();
  }
}
