// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test, vi } from "vitest";
import * as Y from "yjs";

import {
  bindDocumentTitleSync,
  observeDocumentTitle,
} from "./document-title-sync";

describe("document title synchronization", () => {
  test("distinguishes local persistence intent from newer remote title state", () => {
    const localDoc = new Y.Doc();
    const remoteDoc = new Y.Doc();
    const localTitle = localDoc.getText("title");
    const remoteTitle = remoteDoc.getText("title");
    const onChange = vi.fn();
    const stop = observeDocumentTitle(localTitle, onChange);

    localTitle.insert(0, "Local rename");
    expect(onChange).toHaveBeenLastCalledWith("Local rename", true);

    remoteTitle.insert(0, "Remote rename");
    Y.applyUpdate(localDoc, Y.encodeStateAsUpdate(remoteDoc));
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange.mock.calls.at(-1)?.[1]).toBe(false);

    stop();
    localTitle.insert(localTitle.length, " after cleanup");
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  test("invalidates a pending explicit generation on a newer remote leaf title", () => {
    const local = new Y.Doc();
    const remote = new Y.Doc();
    const title = local.getText("title");
    let generation = 0;
    const owner = {
      beginDocTitleIntent: vi.fn(() => ++generation),
      acknowledgeInlineDocTitle: vi.fn(async () => undefined),
    };
    const stop = bindDocumentTitleSync("doc-1", title, owner, vi.fn());
    const explicitGeneration = owner.beginDocTitleIntent();

    remote.getText("title").insert(0, "Remote newer");
    Y.applyUpdate(local, Y.encodeStateAsUpdate(remote));

    expect(generation).toBeGreaterThan(explicitGeneration);
    expect(owner.acknowledgeInlineDocTitle).not.toHaveBeenCalled();
    stop();
  });
});
