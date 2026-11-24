// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FrameworkProvider } from "@myoxus/infra";
import {
  bindDocumentCopy,
  clipboardConfigs,
} from "@virgultum/editor/foundation/clipboard";
import { BlockStdScope } from "@virgultum/editor/std";
import {
  Slice,
  type BlockModel,
  type SliceSnapshot,
} from "@virgultum/editor/store";
import { patchDocEmbedService } from "../../view-extensions/editor-view/doc-embed";

/** A block copy owns its frozen slice until delivery or until its source view closes. */
export async function copyPageBlock(
  model: BlockModel,
  framework: FrameworkProvider,
  signal: AbortSignal,
  selection?: SliceSnapshot,
) {
  const store = model.store;
  signal.throwIfAborted();
  if (store.getModelById(model.id) !== model)
    throw new Error("Clipboard source unavailable");
  const std = new BlockStdScope({
    store,
    extensions: [...clipboardConfigs, patchDocEmbedService(framework)],
  });
  const unbind = bindDocumentCopy(std, false);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    unbind();
    std.unmount();
  };
  signal.addEventListener("abort", close, { once: true });
  try {
    if (selection) await std.clipboard.copySnapshot(selection);
    else await std.clipboard.copySlice(Slice.fromModels(store, [model]));
  } finally {
    signal.removeEventListener("abort", close);
    close();
  }
}
