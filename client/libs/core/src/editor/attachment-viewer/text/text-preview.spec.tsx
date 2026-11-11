// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { signal } from "@preact/signals-core";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { AttachmentBlockModel } from "@virgultum/editor/model";
import { afterEach, expect, test, vi } from "vitest";
import { MarkdownPreview } from "./markdown-preview";
import { decodeAttachmentText, TextAttachmentPreview } from "./text-preview";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("Markdown is readable markup while HTML, active URLs and remote images remain inert", () => {
  const { container } = render(
    <MyoxusUIProvider>
      <MarkdownPreview
        source={
          "# Vorschau\n\n**Wichtig** und *lesbar*.\n\n- [x] **Aufgabe**\n\n| Name | Wert |\n| --- | --- |\n| A | 1 |\n\n[Link](https://example.com) [unsafe](javascript:alert%281%29)\n\n![Bild](https://example.com/tracker.png)\n\n<script>alert(1)</script>"
        }
      />
    </MyoxusUIProvider>,
  );
  expect(screen.getByRole("heading", { name: "Vorschau" })).toBeTruthy();
  expect(container.querySelector("strong")?.textContent).toBe("Wichtig");
  expect(screen.getByRole("table").textContent).toContain("Wert");
  expect(screen.getByRole("link").getAttribute("href")).toBe(
    "https://example.com/",
  );
  expect(container.querySelector("script, img, iframe")).toBeNull();
  const task = screen.getByRole("checkbox", {
    name: "Aufgabe",
  }) as HTMLInputElement;
  expect(task.checked).toBe(true);
  expect(task.disabled).toBe(true);
  expect(container.textContent).toContain("<script>alert(1)</script>");
});

test("explicit Unicode encodings preserve text, while invalid or binary data fails visibly", () => {
  expect(
    decodeAttachmentText(
      new TextEncoder().encode("Ä\n<script>literal</script>").buffer,
    ),
  ).toBe("Ä\n<script>literal</script>");
  expect(
    decodeAttachmentText(new Uint8Array([0xff, 0xfe, 0xc4, 0x00]).buffer),
  ).toBe("Ä");
  expect(() => decodeAttachmentText(new Uint8Array([0xff]).buffer)).toThrow();
  expect(() =>
    decodeAttachmentText(new Uint8Array([65, 0, 66]).buffer),
  ).toThrow();
});

test("a changed blob cancels its predecessor, and an explicit retry recovers a failed current load", async () => {
  let completeOld!: (value: Response) => void;
  let oldSignal: AbortSignal | undefined;
  const fetch = vi
    .fn()
    .mockImplementationOnce((_url, options) => {
      oldSignal = options.signal;
      return new Promise<Response>((resolve) => {
        completeOld = resolve;
      });
    })
    .mockRejectedValueOnce(new Error("temporarily unavailable"))
    .mockResolvedValueOnce(new Response("Neuer Inhalt"));
  vi.stubGlobal("fetch", fetch);
  const model = {
    props: { name$: signal("probe.txt"), type: "text/plain" },
  } as unknown as AttachmentBlockModel;
  const view = (url: string) => (
    <MyoxusUIProvider>
      <TextAttachmentPreview model={model} blobUrl={url} />
    </MyoxusUIProvider>
  );
  const { rerender } = render(view("blob:old"));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  rerender(view("blob:new"));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => completeOld(new Response("Veralteter Inhalt")));
  expect(screen.queryByText("Veralteter Inhalt")).toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  expect(await screen.findByText("Neuer Inhalt")).toBeTruthy();
});
