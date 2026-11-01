// SPDX-License-Identifier: AGPL-3.0-or-later
// First-use UI entry only. Source/worker and passive preview consumers use the
// package's explicit subpaths instead of importing through this modeller barrel.
// Emitted UI assets use the host bundler's same-origin URLs (assets:// in native
// packages); this entry needs no iframe, remote loader or CSP relaxation.
import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  BpmnEditor as RetainedEditor,
  type BpmnEditorRef as RetainedEditorRef,
} from "./editor/BpmnEditor";
import { getMarshaller, type BpmnLatestModel } from "./marshaller";
import { inspectBpmnSource, type BpmnSourceInspection } from "./process-source";
import { sanitizeBpmnSvg } from "./editor/svg/sanitize";

export type BpmnSourceRevision = { revision: string; xml: string };
export type BpmnSnapshot = BpmnSourceRevision & { baseRevision: string };
export type BpmnCommandState = {
  dirty: boolean;
  pendingFields: boolean;
  canUndo: boolean;
  canRedo: boolean;
};
/** Render failure suspends commands but retains the last settled recovery XML;
 * source rejection is a separate admission result. Only installed commands report Ready. */
export type BpmnReadiness =
  | { status: "ready" }
  | { status: "render-error" }
  | Exclude<BpmnSourceInspection, { status: "accepted" }>;
export type BpmnEditorError = {
  code:
    | "BPMN_NOT_READY"
    | "BPMN_PENDING_FIELD_INVALID"
    | "BPMN_SOURCE_WRITE_FAILED"
    | "BPMN_STALE_SNAPSHOT"
    | "BPMN_RENDER_FAILED";
};

/** The host supplies its existing Facade projection, never a BPMN-local palette or font preset. */
export const BPMN_THEME_ROLES = {
  surface: "--mantine-color-body",
  foreground: "--mantine-color-text",
  fontFamily: "--mantine-font-family",
} as const;
export type BpmnThemeRoles = typeof BPMN_THEME_ROLES;

export type BpmnEditorProps = {
  /** Return an emitted revision verbatim to acknowledge it without resetting the mounted store/history. */
  source: BpmnSourceRevision;
  readOnly: boolean;
  locale: string;
  themeRoles: BpmnThemeRoles;
  /** Immediate command/draft notification; source emission alone is deliberately debounced. */
  onCommandStateChange?: (state: BpmnCommandState) => void;
  onSourceChange?: (source: BpmnSnapshot) => void;
  onError?: (error: BpmnEditorError) => void;
  onReadinessChange?: (state: BpmnReadiness) => void;
};
export type BpmnEditorRef = {
  /** Valid drafts commit through their field owners; invalid drafts focus and throw.
   * After renderer failure, only the retained settled candidate (no pending fields)
   * can be recovered. This is not a persistence ACK or a render retry. */
  flush(): BpmnSnapshot;
  /** Preflighted local import, one undoable command. Returns an exact source
   * candidate against the accepted base, not a persistence acknowledgement.
   * Remote source props still reset incompatible history instead. */
  replaceSource(xml: string): BpmnSnapshot;
  /** Sanitized SVG and exact BPMN share one flushed candidate. Async invalidation
   * rejects the result; neither rendering nor downloading acknowledges a save.
   * Cancellation releases derived measurement/font waits, not settled commands. */
  exportSvg(signal?: AbortSignal): Promise<BpmnSnapshot & { svg: string }>;
  undo(): void;
  redo(): void;
  fitToContent(): Promise<void>;
  /** Explicit host discard only. Does not claim a save or change canonical source. */
  discard(): void;
};

/** One source-controlled public entry; Core never receives the retained store, model or envelope protocol. */
export const BpmnEditor = forwardRef<BpmnEditorRef, BpmnEditorProps>(
  function BpmnEditor(props, ref) {
    const [initial] = useState(() => inspectBpmnSource(props.source.xml));
    const [model, setModel] = useState<BpmnLatestModel | undefined>(() =>
      initial.status === "accepted" ? initial.model : undefined,
    );
    const retained = useRef<RetainedEditorRef>(null);
    const [available, setAvailable] = useState(initial.status === "accepted");
    const availableNow = useRef(available);
    const renderFailed = useRef(false);
    const callbacks = useRef(props);
    callbacks.current = props;
    const accepted = useRef(props.source);
    const observed = useRef(props.source);
    const current = useRef(model);
    const baseline = useRef(model);
    const adopting = useRef(true);
    const latest = useRef<
      { model: BpmnLatestModel; snapshot: BpmnSnapshot } | undefined
    >(undefined);
    // Raw imported/previously emitted sources follow their immutable history
    // models. Undo across a save/import must restore bytes, not reserialize an
    // older model against the newest source's lexical envelope. Weak keys keep
    // retention bounded by the existing retained history owner.
    const exactSources = useRef(new WeakMap<BpmnLatestModel, string>());
    const session = useRef(globalThis.crypto.randomUUID());
    const sequence = useRef(0);
    const acknowledgedSequence = useRef(0);
    const retiredSequence = useRef(0);
    const generation = useRef(0);
    const mounted = useRef(true);
    const state = useRef<BpmnCommandState>({
      dirty: false,
      pendingFields: false,
      canUndo: false,
      canRedo: false,
    });
    const report = useCallback(
      () => callbacks.current.onCommandStateChange?.({ ...state.current }),
      [],
    );
    const fail = useCallback((code: BpmnEditorError["code"]): never => {
      callbacks.current.onError?.({ code });
      throw new Error(code);
    }, []);
    const snapshot = useCallback(
      (next: BpmnLatestModel): BpmnSnapshot => {
        if (
          latest.current?.model === next &&
          latest.current.snapshot.baseRevision === accepted.current.revision
        )
          return latest.current.snapshot;
        let xml: string;
        try {
          xml =
            exactSources.current.get(next) ??
            (next === baseline.current
              ? accepted.current.xml
              : getMarshaller(accepted.current.xml).builder.build(next));
        } catch {
          return fail("BPMN_SOURCE_WRITE_FAILED");
        }
        if (xml === accepted.current.xml) {
          baseline.current = next;
          state.current.dirty = state.current.pendingFields;
          report();
          return {
            ...accepted.current,
            baseRevision: accepted.current.revision,
          };
        }
        const value = {
          xml,
          revision: `${session.current}:${++sequence.current}`,
          baseRevision: accepted.current.revision,
        };
        exactSources.current.set(next, xml);
        latest.current = { model: next, snapshot: value };
        return value;
      },
      [fail, report],
    );
    const emit = useCallback(
      (next: BpmnLatestModel) => {
        if (!availableNow.current) return;
        const value = snapshot(next);
        if (value.xml !== accepted.current.xml)
          callbacks.current.onSourceChange?.(value);
      },
      [snapshot],
    );
    const flush = useCallback(() => {
      if (!current.current) return fail("BPMN_NOT_READY");
      // A render failure removes the command tree, not its last settled model.
      // Recover that exact candidate without pretending an uncommitted field
      // draft was validated or turning a download into a source emission.
      if (
        !retained.current &&
        renderFailed.current &&
        !state.current.pendingFields
      )
        return snapshot(current.current);
      if (!availableNow.current || !retained.current)
        return fail("BPMN_NOT_READY");
      let next: BpmnLatestModel;
      try {
        next = retained.current.flush();
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "BPMN_PENDING_FIELD_INVALID"
        )
          return fail("BPMN_PENDING_FIELD_INVALID");
        throw error;
      }
      return snapshot(next);
    }, [fail, snapshot]);
    useImperativeHandle(
      ref,
      () => ({
        flush,
        replaceSource: (xml) => {
          if (
            callbacks.current.readOnly ||
            !availableNow.current ||
            !retained.current
          )
            return fail("BPMN_NOT_READY");
          const inspected = inspectBpmnSource(xml);
          if (inspected.status !== "accepted") return fail("BPMN_NOT_READY");
          const before = flush();
          if (before.xml === xml) return before;
          // Capture the previous exact source before advancing the history.
          exactSources.current.set(current.current!, before.xml);
          const next = retained.current.replaceModel(inspected.model);
          exactSources.current.set(next, xml);
          generation.current++;
          return snapshot(next);
        },
        exportSvg: async (signal) => {
          signal?.throwIfAborted();
          if (!availableNow.current || !retained.current)
            return fail("BPMN_NOT_READY");
          const value = flush();
          const model = current.current;
          const epoch = generation.current;
          const svg = await retained.current!.getDiagramSvg(signal);
          if (
            !mounted.current ||
            epoch !== generation.current ||
            model !== current.current ||
            state.current.pendingFields
          )
            // A concurrent command/remount invalidates derived work normally;
            // callers may retry, but it is not a fatal modeller notification.
            throw new Error("BPMN_STALE_SNAPSHOT");
          if (!svg) return fail("BPMN_NOT_READY");
          return { ...value, svg: sanitizeBpmnSvg(svg, value.revision) };
        },
        undo: () => {
          if (availableNow.current) retained.current?.getCommands().undo();
        },
        redo: () => {
          if (availableNow.current) retained.current?.getCommands().redo();
        },
        fitToContent: async () => {
          await retained.current?.fitToContent();
        },
        discard: () => {
          const inspected = inspectBpmnSource(accepted.current.xml);
          if (inspected.status !== "accepted") return;
          baseline.current = inspected.model;
          current.current = inspected.model;
          latest.current = undefined;
          retiredSequence.current = sequence.current;
          generation.current++;
          adopting.current = true;
          retained.current?.reset(inspected.model);
          if (!retained.current) setModel(inspected.model);
        },
      }),
      [fail, flush, snapshot],
    );
    useLayoutEffect(() => {
      mounted.current = true;
      generation.current++;
      return () => {
        mounted.current = false;
      };
    }, [initial]);
    useEffect(() => {
      if (initial.status !== "accepted")
        callbacks.current.onReadinessChange?.(initial);
    }, [initial]);
    useLayoutEffect(() => {
      const source = props.source;
      if (
        source.revision === observed.current.revision &&
        source.xml === observed.current.xml
      )
        return;
      observed.current = source;
      const prefix = `${session.current}:`;
      const number = source.revision.startsWith(prefix)
        ? Number(source.revision.slice(prefix.length))
        : NaN;
      if (
        Number.isInteger(number) &&
        number > 0 &&
        number <= sequence.current
      ) {
        if (
          number <= retiredSequence.current ||
          number < acknowledgedSequence.current
        )
          return;
        acknowledgedSequence.current = number;
        // The host returns our exact candidate identity. Even an older durable ACK
        // must not replace newer local commands; its source becomes the next base.
        accepted.current = source;
        baseline.current =
          latest.current?.snapshot.revision === source.revision
            ? latest.current.model
            : undefined;
        state.current.dirty =
          state.current.pendingFields || current.current !== baseline.current;
        report();
        return;
      }
      if (source.xml === accepted.current.xml && availableNow.current) {
        accepted.current = source;
        return;
      }
      const inspected = inspectBpmnSource(source.xml);
      if (inspected.status !== "accepted") {
        generation.current++;
        renderFailed.current = false;
        availableNow.current = false;
        setAvailable(false);
        callbacks.current.onReadinessChange?.(inspected);
        return;
      }
      generation.current++;
      availableNow.current = true;
      setAvailable(true);
      accepted.current = source;
      retiredSequence.current = sequence.current;
      baseline.current = inspected.model;
      current.current = inspected.model;
      latest.current = undefined;
      adopting.current = true;
      if (retained.current) {
        retained.current.reset(inspected.model);
        callbacks.current.onReadinessChange?.({ status: "ready" });
      } else {
        // Recovery from an initially rejected source mounts commands for the
        // first time; its actual command owner will publish Ready afterwards.
        setModel(inspected.model);
      }
    }, [props.source, report]);
    if (!model) return null;
    return (
      <RetainedEditor
        ref={retained}
        model={model}
        locale={props.locale}
        readOnly={props.readOnly || !available}
        themeRoles={props.themeRoles}
        onError={() => {
          generation.current++;
          renderFailed.current = true;
          availableNow.current = false;
          setAvailable(false);
          callbacks.current.onReadinessChange?.({ status: "render-error" });
          callbacks.current.onError?.({ code: "BPMN_RENDER_FAILED" });
        }}
        onReady={() => {
          renderFailed.current = false;
          availableNow.current = true;
          setAvailable(true);
          callbacks.current.onReadinessChange?.({ status: "ready" });
        }}
        onModelChange={emit}
        onWorkingStateChange={(next) => {
          if (adopting.current) {
            baseline.current = next.model;
            exactSources.current.set(next.model, accepted.current.xml);
            adopting.current = false;
          }
          current.current = next.model;
          state.current = {
            dirty: next.pending || next.model !== baseline.current,
            pendingFields: next.pending,
            canUndo: next.canUndo,
            canRedo: next.canRedo,
          };
          report();
        }}
      />
    );
  },
);
