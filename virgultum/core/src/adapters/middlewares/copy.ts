import {
  expandAnnotationSelection,
  type RootBlockModel,
} from "../../models/index";
import type { BlockStdScope, TextRangePoint } from "../../runtime/index";
import { TextSelection } from "../../runtime/selection/text";
import type {
  BlockModel,
  BlockSnapshot,
  DraftModel,
  TransformerMiddleware,
} from "../../store/index";
import { LOCAL_FOOTNOTE_COPY_BODY, Slice } from "../../store/index";

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

type CopyRange = { from: TextRangePoint; to?: TextRangePoint | null };

const selectionMiddleware =
  (read: () => CopyRange | undefined): TransformerMiddleware =>
  ({ slots, adapterConfigs }) => {
    const afterExportSubscription = slots.afterExport.subscribe((payload) => {
      if (payload.type === "block") {
        if (adapterConfigs.get(LOCAL_FOOTNOTE_COPY_BODY)) return;
        const snapshot = payload.snapshot;

        const model = payload.model;
        const text = read();
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

export const copyMiddleware = (std: BlockStdScope): TransformerMiddleware =>
  selectionMiddleware(() => std.selection.find(TextSelection));

/** Capture the selected text before loading clipboard adapters or resolving a target title. */
export function captureLeafTextSelection(
  model: BlockModel,
  index: number,
  length: number,
) {
  if (model.children.length || !model.text || length <= 0) return;
  const from = { blockId: model.id, index, length };
  using job = model.store.getTransformer([
    selectionMiddleware(() => ({ from })),
  ]);
  return job.sliceToSnapshot(Slice.fromModels(model.store, [model]));
}
