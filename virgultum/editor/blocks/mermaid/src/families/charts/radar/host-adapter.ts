// SPDX-License-Identifier: AGPL-3.0-or-later

import { consumeMyoxusEditorEscape } from "@virgultum/shared/utils";

import type {
  MermaidRadarCommand,
  MermaidRadarCommandSelection,
} from "../../../engine/charts/radar/commands/types.js";
import type { MermaidRadarModel } from "../../../engine/charts/radar/model.js";
import { mermaidMessages } from "../../../i18n.js";
import {
  type MermaidEditorCapabilities,
  structuredEditorProjection,
} from "../../runtime/editor-capabilities.js";
import { localizedRadarDiagnostic } from "./family.js";
import { mermaidRadarRendererToken } from "./react-host-contract.js";
import type { MermaidRadarCommandProjection } from "./react-host-contract.js";
import { applyMermaidRadarFamilySourceCommand } from "./source-application.js";

type RadarSelectionAnchor =
  | { readonly kind: "diagram" | "options" }
  | { readonly kind: "axis"; readonly name: string }
  | { readonly kind: "curve"; readonly name: string }
  | {
      readonly axisName: string;
      readonly curveName: string;
      readonly entryFingerprint?: string;
      readonly kind: "vertex";
    }
  | {
      readonly fingerprint: string;
      readonly kind: "comment";
      readonly recordId: string;
    };

type RadarSelectionHistoryEntry = {
  readonly anchor: RadarSelectionAnchor;
  readonly sourceHash: string;
};

function selectionAnchor(
  model: MermaidRadarModel,
  selection: MermaidRadarCommandSelection,
): RadarSelectionAnchor | null {
  if (selection.kind === "diagram" || selection.kind === "options")
    return selection;
  if (selection.kind === "axis") {
    const axis = model.axes.find((candidate) => candidate.id === selection.id);
    return axis ? { kind: "axis", name: axis.name } : null;
  }
  if (selection.kind === "curve") {
    const curve = model.curves.find(
      (candidate) => candidate.id === selection.id,
    );
    return curve ? { kind: "curve", name: curve.name } : null;
  }
  if (selection.kind === "vertex") {
    const curve = model.curves.find((candidate) =>
      candidate.vertices.some((vertex) => vertex.id === selection.id),
    );
    const vertex = curve?.vertices.find(
      (candidate) => candidate.id === selection.id,
    );
    const axis = vertex
      ? model.axes.find((candidate) => candidate.id === vertex.axisId)
      : undefined;
    const entry = vertex?.entryId
      ? curve?.entries.find((candidate) => candidate.id === vertex.entryId)
      : undefined;
    return curve && axis
      ? {
          axisName: axis.name,
          curveName: curve.name,
          entryFingerprint: entry?.sourceFingerprint,
          kind: "vertex",
        }
      : null;
  }
  if (selection.kind !== "comment") return null;
  const comment = model.comments.find(
    (candidate) => candidate.id === selection.id,
  );
  const record = comment
    ? model.sourceDocument.records.find(
        (candidate) => candidate.id === comment.sourceRecordId,
      )
    : undefined;
  return record
    ? {
        fingerprint: record.fingerprint,
        kind: "comment",
        recordId: record.id,
      }
    : null;
}

function resolveSelectionAnchor(
  model: MermaidRadarModel,
  anchor: RadarSelectionAnchor,
): MermaidRadarCommandSelection | undefined {
  if (anchor.kind === "diagram" || anchor.kind === "options") return anchor;
  if (anchor.kind === "axis") {
    const axis = model.axes.find((candidate) => candidate.name === anchor.name);
    return axis ? { id: axis.id, kind: "axis" } : undefined;
  }
  if (anchor.kind === "curve") {
    const curve = model.curves.find(
      (candidate) => candidate.name === anchor.name,
    );
    return curve ? { id: curve.id, kind: "curve" } : undefined;
  }
  if (anchor.kind === "vertex") {
    const curve = model.curves.find(
      (candidate) => candidate.name === anchor.curveName,
    );
    const axis = model.axes.find(
      (candidate) => candidate.name === anchor.axisName,
    );
    const vertex =
      curve && axis
        ? curve.vertices.find((candidate) => candidate.axisId === axis.id)
        : undefined;
    if (!vertex) return undefined;
    if (anchor.entryFingerprint && vertex.entryId) {
      const entry = curve?.entries.find(
        (candidate) => candidate.id === vertex.entryId,
      );
      if (entry?.sourceFingerprint !== anchor.entryFingerprint)
        return undefined;
    }
    return { id: vertex.id, kind: "vertex" };
  }
  if (anchor.kind !== "comment") return undefined;
  const record =
    model.sourceDocument.records.find(
      (candidate) =>
        candidate.kind === "comment" && candidate.id === anchor.recordId,
    ) ??
    model.sourceDocument.records.find(
      (candidate) =>
        candidate.kind === "comment" &&
        candidate.fingerprint === anchor.fingerprint,
    );
  const comment = record
    ? model.comments.find((candidate) => candidate.sourceRecordId === record.id)
    : undefined;
  return comment ? { id: comment.id, kind: "comment" } : undefined;
}

function sessionHistory(value: unknown): RadarSelectionHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) =>
    entry &&
    typeof entry === "object" &&
    "sourceHash" in entry &&
    typeof entry.sourceHash === "string" &&
    "anchor" in entry &&
    entry.anchor &&
    typeof entry.anchor === "object"
      ? [entry as RadarSelectionHistoryEntry]
      : [],
  );
}

export function radarEditorCapabilities(
  source: string,
  model: MermaidRadarModel,
): MermaidEditorCapabilities {
  const localizedModel = {
    ...model,
    diagnostics: model.diagnostics.map(localizedRadarDiagnostic),
  };
  return {
    kind: "structured",
    project: (context, displayOnly) => {
      const readonly = context.getReadonly() || displayOnly;
      let persistedHistory = sessionHistory(
        context.getSessionState("radar.selection-history"),
      );
      const transientHistory =
        context.getTransientState("radar.selection-history") instanceof Map
          ? (context.getTransientState("radar.selection-history") as Map<
              string,
              MermaidRadarCommandSelection | undefined
            >)
          : new Map<string, MermaidRadarCommandSelection | undefined>();
      context.setTransientState("radar.selection-history", transientHistory);
      const rememberSelection = (
        selectionModel: MermaidRadarModel,
        selection?: MermaidRadarCommandSelection,
      ) => {
        transientHistory.set(selectionModel.sourceHash, selection);
        while (transientHistory.size > 100)
          transientHistory.delete(transientHistory.keys().next().value!);
        if (!selection) return;
        const anchor = selectionAnchor(selectionModel, selection);
        if (!anchor) return;
        persistedHistory = [
          ...persistedHistory.filter(
            (entry) => entry.sourceHash !== selectionModel.sourceHash,
          ),
          { anchor, sourceHash: selectionModel.sourceHash },
        ].slice(-100);
        context.setSessionState("radar.selection-history", persistedHistory);
      };
      const pendingFocus = sessionHistory([
        context.getSessionState("radar.focus-request"),
      ])[0];
      const focusSelection =
        pendingFocus?.sourceHash === model.sourceHash
          ? resolveSelectionAnchor(model, pendingFocus.anchor)
          : undefined;
      type AppliedRadarCommands =
        | (MermaidRadarCommandProjection & {
            readonly changed: false;
          })
        | (MermaidRadarCommandProjection & {
            readonly changed: true;
            readonly source: string;
          });
      const applyCommands = (
        command: MermaidRadarCommand | readonly MermaidRadarCommand[],
      ): AppliedRadarCommands => {
        const commands = Array.isArray(command)
          ? command
          : [command as MermaidRadarCommand];
        let currentModel = model;
        let currentSource = source;
        let selection: MermaidRadarCommandSelection | null = null;
        for (const concreteCommand of commands) {
          const result = applyMermaidRadarFamilySourceCommand({
            baseSourceHash: currentModel.sourceHash,
            command: concreteCommand,
            model: currentModel,
            readonly,
            source: currentSource,
          });
          if (!result.changed)
            return {
              changed: false,
              diagnosis: result.diagnosis,
              model: localizedModel,
              selection: null,
            };
          currentModel = result.model;
          currentSource = result.source;
          selection = result.selectionAfter;
        }
        if (currentSource === source)
          return {
            changed: false,
            diagnosis: "radar.no-change",
            model: localizedModel,
            selection: null,
          };
        return {
          changed: true,
          diagnosis: "radar.ok",
          model: {
            ...currentModel,
            diagnostics: currentModel.diagnostics.map(localizedRadarDiagnostic),
          },
          selection,
          source: currentSource,
        };
      };
      const body = context
        .getReactHost()
        ?.renderFamilyEditor(mermaidRadarRendererToken, {
          actionTarget: displayOnly
            ? null
            : context.embedded
              ? undefined
              : context.getActionTarget(),
          displayOnly: Boolean(displayOnly && context.embedded),
          embedded: Boolean(context.embedded),
          getRememberedSelection: (selectionModel) => {
            if (transientHistory.has(selectionModel.sourceHash))
              return transientHistory.get(selectionModel.sourceHash);
            const exact = persistedHistory.findLast(
              (entry) => entry.sourceHash === selectionModel.sourceHash,
            );
            if (exact)
              return resolveSelectionAnchor(selectionModel, exact.anchor);
            for (const persisted of [...persistedHistory].reverse()) {
              const resolved = resolveSelectionAnchor(
                selectionModel,
                persisted.anchor,
              );
              if (resolved) return resolved;
            }
            return undefined;
          },
          headerActionTarget:
            displayOnly && context.embedded
              ? null
              : context.getHeaderActionTarget(),
          initialDataOpen:
            context.getTransientState("radar.data-open") === true,
          focusRequest: focusSelection
            ? { key: model.sourceHash, selection: focusSelection }
            : undefined,
          labels: {
            accessibilityDescription:
              mermaidMessages.visualAccessibilityDescription(),
            accessibilityTitle: mermaidMessages.visualAccessibilityTitle(),
            addAxis: mermaidMessages.chartAddAxis(),
            addComment: mermaidMessages.architectureAddComment(),
            addCurve: mermaidMessages.chartAddCurve(),
            ambiguousSource: mermaidMessages.radarDiagnosticAmbiguousSource(),
            apply: mermaidMessages.architectureApply(),
            automatic: mermaidMessages.radarAutomatic(),
            axis: mermaidMessages.radarAxis(),
            cancel: mermaidMessages.cancel(),
            circle: mermaidMessages.shapeCircle(),
            comments: mermaidMessages.visualComments(),
            configuration: mermaidMessages.radarConfiguration(),
            configurationFields: {
              axisLabelFactor: mermaidMessages.radarAxisLabelFactor(),
              axisScaleFactor: mermaidMessages.radarAxisScaleFactor(),
              curveTension: mermaidMessages.radarCurveTension(),
              height: mermaidMessages.xyHeight(),
              marginBottom: mermaidMessages.radarMarginBottom(),
              marginLeft: mermaidMessages.radarMarginLeft(),
              marginRight: mermaidMessages.radarMarginRight(),
              marginTop: mermaidMessages.radarMarginTop(),
              useMaxWidth: mermaidMessages.xyUseMaxWidth(),
              width: mermaidMessages.xyWidth(),
            },
            clippedVertices: mermaidMessages.radarClippedVertices,
            commentCount: mermaidMessages.radarCommentCount,
            commentAfter: mermaidMessages.radarCommentAfter(),
            commentAnchor: mermaidMessages.radarCommentAnchor,
            commentBefore: mermaidMessages.radarCommentBefore(),
            commentOwnerRemovalBlocked:
              mermaidMessages.radarCommentOwnerRemovalBlocked(),
            conversionImpact: mermaidMessages.radarConversionImpact,
            convertForm: mermaidMessages.radarConvertForm(),
            curve: mermaidMessages.radarCurve(),
            data: mermaidMessages.pieData(),
            delete: mermaidMessages.visualDelete(),
            deleteAxisImpact: mermaidMessages.radarDeleteAxisImpact,
            deleteCurveImpact: mermaidMessages.radarDeleteCurveImpact,
            deleteVertexImpact: mermaidMessages.radarDeleteVertexImpact(),
            defaultValue: mermaidMessages.radarDefaultValue,
            detailed: mermaidMessages.radarDetailed(),
            duplicateReference:
              mermaidMessages.radarDiagnosticDuplicateReference(),
            emptyAxes: mermaidMessages.radarEmptyAxes(),
            emptyCurves: mermaidMessages.radarEmptyCurves(),
            effectiveValue: mermaidMessages.effectiveValue,
            graticule: mermaidMessages.radarGraticule(),
            invalid: mermaidMessages.radarCommandInvalid(),
            invalidConfig: mermaidMessages.radarDiagnosticInvalidConfig(),
            invalidNumber: mermaidMessages.radarDiagnosticInvalidNumber(),
            invalidOption: mermaidMessages.radarDiagnosticInvalidOption(),
            invalidRange: mermaidMessages.radarDiagnosticInvalidRange(),
            label: mermaidMessages.radarVisibleLabel(),
            maximum: mermaidMessages.radarMaximum(),
            minimum: mermaidMessages.radarMinimum(),
            missingReference: mermaidMessages.radarDiagnosticMissingReference(),
            more: mermaidMessages.visualMoreActions(),
            name: mermaidMessages.radarSourceName(),
            options: mermaidMessages.visualAppearance(),
            polygon: mermaidMessages.radarPolygon(),
            positional: mermaidMessages.radarPositional(),
            reset: mermaidMessages.architectureReset(),
            retry: mermaidMessages.visualRetry(),
            rendererError: mermaidMessages.visualRendererError(),
            showLegend: mermaidMessages.radarShowLegend(),
            source: mermaidMessages.modeSource(),
            sourceChanged: mermaidMessages.chartSourceChanged(),
            sourceValue: mermaidMessages.sourceValue,
            ticks: mermaidMessages.radarTicks(),
            value: mermaidMessages.selectedRadarValue(),
            valueStep: mermaidMessages.radarValueStep,
            visualEditor: mermaidMessages.visualEditorLabel(),
          },
          model: localizedModel,
          onCommand: (command, options) => {
            const result = applyCommands(command);
            if (result.changed && "source" in result) {
              if (result.selection) {
                rememberSelection(result.model, result.selection);
                const anchor = selectionAnchor(result.model, result.selection);
                if (anchor)
                  context.setSessionState("radar.focus-request", {
                    anchor,
                    sourceHash: result.model.sourceHash,
                  } satisfies RadarSelectionHistoryEntry);
              }
              context.commitSource(result.source, options);
            }
            return result;
          },
          onDataOpenChange: (opened) =>
            context.setTransientState("radar.data-open", opened),
          onConsumeEscape: consumeMyoxusEditorEscape,
          onFocusRequestConsumed: () =>
            context.setSessionState("radar.focus-request", undefined),
          onOpenSource: context.openSource,
          onPreviewCommand: applyCommands,
          onSelectionActionChange: context.setSelectionAction,
          pageViewport: context.getPageViewport(),
          readonly,
          rememberSelection,
        });
      return structuredEditorProjection(
        body ?? context.renderSourceFirst(),
        mermaidMessages.visualEditorLabel(),
        readonly,
        context.getSelectionAction(),
      );
    },
    renderSurface: "core-facade",
  };
}
