// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom
import { expect, test, vi } from "vitest";
import { Framework } from "@myoxus/infra";

import { AIDraftService, type AIDraftGlobal } from "./ai-draft";

test("concurrent draft parts merge current state and persist in order through cache waits and failures", async ({
  onTestFinished,
}) => {
  let releaseRestore!: (value: ArrayBuffer) => void;
  const restore = new Promise<ArrayBuffer>((resolve) => {
    releaseRestore = resolve;
  });
  let saved: AIDraftGlobal = {
    input: "stored",
    quote: "",
    markdown: "",
    images: [
      {
        name: "old.png",
        size: 3,
        type: "image/png",
        cacheKey: "AIDraftFile:old.png3",
      },
    ],
  };
  const writes: AIDraftGlobal[] = [];
  const cache = {
    get: vi.fn(() => restore),
    set: vi.fn(async () => {}),
    del: vi.fn(async () => {}),
  };
  const framework = new Framework();
  framework.service(
    AIDraftService,
    () =>
      new AIDraftService(
        {
          globalState: {
            get: () => saved,
            set: (_key: string, value: AIDraftGlobal) => {
              saved = value;
              writes.push(value);
            },
          },
        } as never,
        cache as never,
      ),
  );
  const provider = framework.provider();
  onTestFinished(() => provider.dispose());
  const service = provider.get(AIDraftService);
  const initial = service.getDraft();
  const text = service.setDraft({ input: "restored after failure" });
  const context = service.setDraft({ quote: "retained selection", images: [] });
  expect(cache.get).toHaveBeenCalledOnce();
  releaseRestore(new Uint8Array([1, 2, 3]).buffer);
  await Promise.all([initial, text, context]);
  expect(await service.getDraft()).toMatchObject({
    input: "restored after failure",
    quote: "retained selection",
    images: [],
  });
  expect(saved).toMatchObject({
    input: "restored after failure",
    quote: "retained selection",
    images: [],
  });

  let finishImage!: () => void;
  const imageWrite = new Promise<void>((resolve) => {
    finishImage = resolve;
  });
  cache.set.mockImplementationOnce(() => imageWrite);
  const before = writes.length;
  const image = service.setDraft({
    images: [new File(["new"], "new.png", { type: "image/png" })],
  });
  const newer = service.setDraft({
    input: "newer while image cache is pending",
  });
  await vi.waitFor(() => expect(cache.set).toHaveBeenCalledOnce());
  expect((await service.getDraft()).input).toBe(
    "newer while image cache is pending",
  );
  expect(writes).toHaveLength(before);
  finishImage();
  await Promise.all([image, newer]);
  expect(writes.slice(-2).map((write) => write.input)).toEqual([
    "restored after failure",
    "newer while image cache is pending",
  ]);
  expect(saved.images.map((image) => image.name)).toEqual(["new.png"]);

  const failure = new Error("controlled draft cache failure");
  cache.del.mockRejectedValueOnce(failure);
  await expect(service.setDraft({ images: [] })).rejects.toBe(failure);
  await service.setDraft({ quote: "after storage failure" });
  expect(saved).toMatchObject({
    input: "newer while image cache is pending",
    quote: "after storage failure",
    images: [],
  });
});
