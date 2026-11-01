import {
  expandAnnotationSelection,
  type RootBlockModel,
} from "@virgultum/model";
import {
  type BlockStdScope,
  type EditorHost,
  type TextRangePoint,
  TextSelection,
} from "@virgultum/std";
import type {
  BlockSnapshot,
  DraftModel,
  TransformerMiddleware,
  TransformerSlots,
} from "@virgultum/store";
import { LOCAL_FOOTNOTE_COPY_BODY } from "@virgultum/store";

const isRootDraftModel = (
  model: DraftModel,
): model is DraftModel<RootBlockModel> => model.flavour === "myoxus:root";

const handlePoint = (
  point: TextRangePoint,
  snapshot: BlockSnapshot,
  model: DraftModel,
) => {
  const source = isRootDraftModel(model) ? model.props.title : model.text;
  const { index, length } = source
    ? expandAnnotationSelection(source.toDelta(), point.index, point.length)
    : point;
  if (isRootDraftModel(model)) {
    if (length === 0) return;
    (snapshot.props.title as Record<string, unknown>).delta =
      model.props.title.sliceToDelta(index, length + index);
    return;
  }

  if (!snapshot.props.text || length === 0) {
    return;
  }
  (snapshot.props.text as Record<string, unknown>).delta =
    model.text?.sliceToDelta(index, length + index);
};

const sliceText = (
  slots: TransformerSlots,
  std: EditorHost["std"],
  configs: Map<string, unknown>,
) => {
  const afterExportSubscription = slots.afterExport.subscribe((payload) => {
    if (payload.type === "block") {
      if (configs.get(LOCAL_FOOTNOTE_COPY_BODY)) return;
      const snapshot = payload.snapshot;

      const model = payload.model;
      const text = std.selection.find(TextSelection);
      if (text && text.from.blockId === model.id) {
        handlePoint(text.from, snapshot, model);
        return;
      }
      if (text && text.to && text.to.blockId === model.id) {
        handlePoint(text.to, snapshot, model);
        return;
      }
    }
  });

  return () => {
    afterExportSubscription.unsubscribe();
  };
};

export const copyMiddleware = (std: BlockStdScope): TransformerMiddleware => {
  return ({ slots, adapterConfigs }) => {
    return sliceText(slots, std, adapterConfigs);
  };
};
