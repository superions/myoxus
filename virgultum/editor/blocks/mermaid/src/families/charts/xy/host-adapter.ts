// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidXyCommand } from "../../../engine/charts/xy/commands/types.js";
import { DEFAULT_MERMAID_XY_CONFIG } from "../../../engine/charts/xy/model.js";
import type { MermaidXyModel } from "../../../engine/charts/xy/model.js";
import { mermaidMessages } from "../../../i18n.js";
import {
  type MermaidEditorCapabilities,
  structuredEditorProjection,
} from "../../runtime/editor-capabilities.js";
import { applyMermaidXyFamilySourceCommand } from "./source-application.js";
import { mermaidXyRendererToken } from "./react-host-contract.js";
import { localizedXyDiagnostic } from "./family.js";

type XySelectionAnchor =
  | { readonly kind: "x-axis" | "y-axis" }
  | {
      readonly fingerprint: string;
      readonly kind: "category" | "plot" | "point";
      readonly rangeStart: number;
    };

type XySelectionHistoryEntry = {
  readonly anchor: XySelectionAnchor | null;
  readonly sourceHash: string;
};

function selectionExists(model: MermaidXyModel, id: string) {
  return (
    id === "xy-axis-x" ||
    id === "xy-axis-y" ||
    model.xAxis.categories.some((category) => category.id === id) ||
    model.plots.some(
      (plot) => plot.id === id || plot.points.some((point) => point.id === id),
    )
  );
}

function selectionAnchor(
  model: MermaidXyModel,
  id?: string,
): XySelectionAnchor | null {
  if (!id) return null;
  if (id === "xy-axis-x") return { kind: "x-axis" };
  if (id === "xy-axis-y") return { kind: "y-axis" };
  const category = model.xAxis.categories.find((item) => item.id === id);
  if (category)
    return {
      fingerprint: category.sourceFingerprint,
      kind: "category",
      rangeStart: category.sourceRangeStart,
    };
  for (const plot of model.plots) {
    if (plot.id === id) {
      const record = model.sourceDocument.records.find(
        (item) => item.id === plot.sourceRecordId,
      );
      return {
        fingerprint: plot.sourceFingerprint,
        kind: "plot",
        rangeStart: record?.range.start ?? -1,
      };
    }
    const point = plot.points.find((item) => item.id === id);
    if (point)
      return {
        fingerprint: point.sourceFingerprint,
        kind: "point",
        rangeStart: point.sourceRangeStart,
      };
  }
  return null;
}

function resolveSelectionAnchor(
  model: MermaidXyModel,
  anchor: XySelectionAnchor | null,
) {
  if (!anchor) return undefined;
  if (!("fingerprint" in anchor))
    return anchor.kind === "x-axis" ? "xy-axis-x" : "xy-axis-y";
  const { fingerprint, rangeStart } = anchor;
  const candidates =
    anchor.kind === "category"
      ? model.xAxis.categories
      : anchor.kind === "plot"
        ? model.plots.map((plot) => ({
            ...plot,
            sourceRangeStart:
              model.sourceDocument.records.find(
                (record) => record.id === plot.sourceRecordId,
              )?.range.start ?? -1,
          }))
        : model.plots.flatMap((plot) => plot.points);
  const exact = candidates.find(
    (candidate) =>
      candidate.sourceFingerprint === fingerprint &&
      candidate.sourceRangeStart === rangeStart,
  );
  if (exact) return exact.id;
  const fingerprintMatches = candidates.filter(
    (candidate) => candidate.sourceFingerprint === fingerprint,
  );
  return fingerprintMatches.length === 1 ? fingerprintMatches[0].id : undefined;
}

function sessionSelectionHistory(value: unknown): XySelectionHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      !("sourceHash" in entry) ||
      typeof entry.sourceHash !== "string" ||
      !("anchor" in entry) ||
      (entry.anchor !== null &&
        (typeof entry.anchor !== "object" || !("kind" in entry.anchor)))
    )
      return [];
    return [entry as XySelectionHistoryEntry];
  });
}

export function xyEditorCapabilities(
  source: string,
  model: MermaidXyModel,
): MermaidEditorCapabilities {
  const localizedModel = {
    ...model,
    diagnostics: model.diagnostics.map(localizedXyDiagnostic),
  };
  return {
    kind: "structured",
    titlePresentation: {
      fontSize:
        model.config.titleFontSize ?? DEFAULT_MERMAID_XY_CONFIG.titleFontSize,
      padding:
        model.config.titlePadding ?? DEFAULT_MERMAID_XY_CONFIG.titlePadding,
      visible: model.config.showTitle ?? true,
    },
    project: (context, displayOnly) => {
      const readonly = context.getReadonly() || displayOnly;
      const selectionHistory =
        context.getTransientState("xy.selection-history") instanceof Map
          ? (context.getTransientState("xy.selection-history") as Map<
              string,
              string | undefined
            >)
          : new Map<string, string | undefined>();
      context.setTransientState("xy.selection-history", selectionHistory);
      let persistedSelectionHistory = sessionSelectionHistory(
        context.getSessionState("xy.selection-history"),
      );
      const rememberSelection = (
        selectionModel: MermaidXyModel,
        selection?: string,
      ) => {
        selectionHistory.delete(selectionModel.sourceHash);
        selectionHistory.set(selectionModel.sourceHash, selection);
        if (selectionHistory.size > 100)
          selectionHistory.delete(selectionHistory.keys().next().value!);
        persistedSelectionHistory = [
          ...persistedSelectionHistory.filter(
            (entry) => entry.sourceHash !== selectionModel.sourceHash,
          ),
          {
            anchor: selectionAnchor(selectionModel, selection),
            sourceHash: selectionModel.sourceHash,
          },
        ].slice(-100);
        context.setSessionState(
          "xy.selection-history",
          persistedSelectionHistory,
        );
      };
      const applyCommands = (
        command: MermaidXyCommand | readonly MermaidXyCommand[],
      ) => {
        const commands: readonly MermaidXyCommand[] = Array.isArray(command)
          ? command
          : [command as MermaidXyCommand];
        let currentModel = model;
        let currentSource = source;
        let selection = null;
        for (const concreteCommand of commands) {
          const result = applyMermaidXyFamilySourceCommand({
            baseSourceHash: currentModel.sourceHash,
            command: concreteCommand,
            model: currentModel,
            readonly,
            source: currentSource,
          });
          if (!result.changed)
            return {
              changed: false,
              diagnosis: result.diagnosis.code,
              model,
              selection: null,
              source,
            };
          currentModel = {
            ...result.model,
            diagnostics: result.model.diagnostics.map(localizedXyDiagnostic),
          };
          currentSource = result.source;
          selection = result.selectionAfter;
        }
        return {
          changed: Boolean(selection),
          diagnosis: selection ? "xy.ok" : "xy.patch-unavailable",
          model: currentModel,
          selection,
          source: currentSource,
        };
      };
      const body = context
        .getReactHost()
        ?.renderFamilyEditor(mermaidXyRendererToken, {
          actionTarget: displayOnly
            ? null
            : context.embedded
              ? undefined
              : context.getActionTarget(),
          embedded: Boolean(context.embedded),
          headerActionTarget: context.getHeaderActionTarget(),
          labels: {
            accessibilityDescription:
              mermaidMessages.visualAccessibilityDescription(),
            accessibilityTitle: mermaidMessages.visualAccessibilityTitle(),
            addCategory: mermaidMessages.chartAddCategory(),
            addComment: mermaidMessages.architectureAddComment(),
            addPlot: mermaidMessages.xyAddPlot(),
            addPoint: mermaidMessages.chartAddPoint(),
            apply: mermaidMessages.architectureApply(),
            autoAxis: mermaidMessages.xyAutoAxis(),
            axes: mermaidMessages.xyAxes(),
            appearance: mermaidMessages.visualAppearance(),
            bar: mermaidMessages.chartBar(),
            bandAxis: mermaidMessages.xyBandAxis(),
            cancel: mermaidMessages.cancel(),
            category: mermaidMessages.xyCategory(),
            chart: mermaidMessages.visualEditorLabel(),
            comments: mermaidMessages.visualComments(),
            data: mermaidMessages.pieData(),
            delete: mermaidMessages.visualDelete(),
            deleteCategoryImpact: mermaidMessages.xyDeleteCategoryImpact,
            deleteCategoryPlotValue: mermaidMessages.xyDeleteCategoryPlotValue,
            deleteCategoryPlotMissing:
              mermaidMessages.xyDeleteCategoryPlotMissing,
            deletePlotImpact: mermaidMessages.xyDeletePlotImpact,
            deletePointImpact: mermaidMessages.xyDeletePointImpact,
            deleteLinearPointImpact: mermaidMessages.xyDeleteLinearPointImpact,
            down: mermaidMessages.visualMoveDown(),
            empty: mermaidMessages.xyEmpty(),
            explicitRange: mermaidMessages.xyExplicitRange(),
            horizontal: mermaidMessages.xyHorizontal(),
            invalid: mermaidMessages.xyCommandInvalid(),
            label: mermaidMessages.quadrantPointLabel(),
            line: mermaidMessages.chartLine(),
            linearAxis: mermaidMessages.xyLinearAxis(),
            linearPointOrderImpact: mermaidMessages.xyLinearPointOrderImpact,
            more: mermaidMessages.visualMoreActions(),
            markdown: mermaidMessages.quadrantMarkdown(),
            plain: mermaidMessages.quadrantPlain(),
            plot: mermaidMessages.xyPlot(),
            plotPointCount: mermaidMessages.xyPlotPointCount,
            reset: mermaidMessages.architectureReset(),
            retry: mermaidMessages.visualRetry(),
            rendererError: mermaidMessages.visualRendererError(),
            quoted: mermaidMessages.quadrantQuoted(),
            rangePreview: mermaidMessages.xyRangePreview,
            orientationAuthority: mermaidMessages.xyOrientationAuthority,
            plotPositions: mermaidMessages.xyPlotPositions,
            unmatchedPoint: mermaidMessages.xyUnmatchedPoint,
            missingPoint: mermaidMessages.xyMissingPoint(),
            sourceChanged: mermaidMessages.pieSourceChanged(),
            source: mermaidMessages.modeSource(),
            up: mermaidMessages.visualMoveUp(),
            value: mermaidMessages.selectedXyValue(),
            valueStep: mermaidMessages.xyValueStep,
            vertical: mermaidMessages.xyVertical(),
            x: mermaidMessages.chartX(),
            xAxisEnd: mermaidMessages.chartXAxisEnd(),
            xAxisStart: mermaidMessages.chartXAxisStart(),
            y: mermaidMessages.chartY(),
            yAxisMaximum: mermaidMessages.chartYAxisMaximum(),
            yAxisMinimum: mermaidMessages.chartYAxisMinimum(),
            axisConversionImpact: mermaidMessages.xyAxisConversionImpact(),
            autoXSource: mermaidMessages.xyAutoXSource,
            commandFailure: (code) => {
              if (code === "xy.category-mismatch-resolution-required")
                return mermaidMessages.xyCategoryReorderBlocked();
              if (
                code === "xy.plot-point-minimum" ||
                code === "xy.category-delete-empty-plot" ||
                code === "xy.category-minimum"
              )
                return mermaidMessages.xyMinimumPointRequired();
              if (code === "xy.stale-source")
                return mermaidMessages.pieSourceChanged();
              return code === "xy.no-change"
                ? ""
                : mermaidMessages.xyCommandInvalid();
            },
            appearanceFields: {
              axisLineWidth: mermaidMessages.xyAxisLineWidth(),
              height: mermaidMessages.xyHeight(),
              labelFontSize: mermaidMessages.xyLabelFontSize(),
              labelPadding: mermaidMessages.xyLabelPadding(),
              labelRotation: mermaidMessages.xyLabelRotation(),
              plotReservedSpacePercent: mermaidMessages.xyPlotReservedSpace(),
              showAxisLine: mermaidMessages.xyShowAxisLine(),
              showDataLabel: mermaidMessages.xyShowDataLabel(),
              showDataLabelOutsideBar:
                mermaidMessages.xyShowDataLabelOutsideBar(),
              showLabel: mermaidMessages.xyShowLabel(),
              showTick: mermaidMessages.xyShowTick(),
              showTitle: mermaidMessages.xyShowTitle(),
              tickLength: mermaidMessages.xyTickLength(),
              tickWidth: mermaidMessages.xyTickWidth(),
              titleFontSize: mermaidMessages.xyTitleFontSize(),
              titlePadding: mermaidMessages.xyTitlePadding(),
              useMaxWidth: mermaidMessages.xyUseMaxWidth(),
              width: mermaidMessages.xyWidth(),
            },
          },
          model: localizedModel,
          getRememberedSelection: (selectionModel) => {
            if (selectionHistory.has(selectionModel.sourceHash)) {
              const remembered = selectionHistory.get(
                selectionModel.sourceHash,
              );
              return remembered && selectionExists(selectionModel, remembered)
                ? remembered
                : undefined;
            }
            const persisted = persistedSelectionHistory.findLast(
              (entry) => entry.sourceHash === selectionModel.sourceHash,
            );
            return persisted
              ? resolveSelectionAnchor(selectionModel, persisted.anchor)
              : undefined;
          },
          initialDataOpen: context.getTransientState("xy.data-open") === true,
          onCommand: (command, options) => {
            const result = applyCommands(command);
            if (result.changed) context.commitSource(result.source, options);
            return result;
          },
          onPreviewCommand: applyCommands,
          rememberSelection,
          onOpenSource: context.openSource,
          onDataOpenChange: (opened) =>
            context.setTransientState("xy.data-open", opened),
          onSelectionActionChange: context.setSelectionAction,
          onTitlePresentationPreview: context.setTitlePresentationPreview,
          pageViewport: context.getPageViewport(),
          readonly,
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
