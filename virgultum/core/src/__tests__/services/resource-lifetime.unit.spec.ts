// SPDX-License-Identifier: AGPL-3.0-or-later
import { signal } from "@preact/signals-core";
import { expect, it, vi } from "vitest";
import { NoopLogger } from "../../primitives/utils";
import { BlobEngine } from "../../sync/blob/engine";
import { MemoryBlobSource } from "../../sync/blob/impl/memory";
import { ResourceController } from "../../resource";

it("only serves the current attachment and releases its bytes on unmount", async () => {
  const source = new MemoryBlobSource();
  await source.set("current", new Blob(["current attachment"]));
  const delayed = Promise.withResolvers<Blob>();
  vi.spyOn(source, "get").mockReturnValueOnce(delayed.promise);
  const id = signal("original");
  const view = new ResourceController(id).setEngine(
    new BlobEngine(source, [], new NoopLogger()),
  );
  const original = view.refreshUrlWith();
  id.value = "current";
  await view.refreshUrlWith();
  delayed.resolve(new Blob(["old attachment"]));
  await original;
  const url = view.blobUrl$.peek()!;
  expect(await (await fetch(url)).text()).toBe("current attachment");

  const pending = view.refreshUrlWith();
  view.dispose();
  await pending;
  expect(view.blobUrl$.peek()).toBeNull();
  await expect(fetch(url)).rejects.toThrow();
});
