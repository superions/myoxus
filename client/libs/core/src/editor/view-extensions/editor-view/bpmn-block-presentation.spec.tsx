// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom
import { useEffect, useRef, useMemo } from "react";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { I18nextProvider, getOrCreateI18n } from "@myoxus/i18n";
import { useLitPortalFactory } from "@myoxus/lit-react";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  BpmnBlockPresentationIdentifier,
  type BpmnBlockPresentationProps,
} from "@virgultum/block-bpmn";
import { Container } from "@virgultum/global/di";
import { render as renderLit } from "lit";
import { patchBpmnBlockPresentation } from "./bpmn-block-presentation";
import { materializeDiagramExportSvg } from "../../../components/hooks/myoxus/diagram-export-svg";
import { prepareBpmnPreviewSvg } from "@myoxus/bpmn-editor/preview";
import { BehaviorSubject } from "rxjs";
import type { DocFrontendDocState } from "@myoxus/storage";
const sync = new BehaviorSubject<DocFrontendDocState>({
  ready: true,
  loaded: true,
  updating: false,
  syncing: false,
  synced: true,
  remoteMissing: false,
  syncRetrying: false,
  syncErrorMessage: null,
});
const docStorage = {
  docState$: () => sync,
  waitForSynced: vi.fn(async () => {}),
};
vi.mock("@myoxus/bpmn-editor/preview", () => ({
  prepareBpmnPreviewSvg: vi.fn(
    () => '<svg xmlns="http://www.w3.org/2000/svg"/>',
  ),
}));

// Root frontend setup disables custom-element registration. This consuming
// test needs the real Lit portal lifecycle rather than an inert anchor tag.
vi.hoisted(() => vi.unstubAllGlobals());
vi.unmock("@myoxus/i18n");
vi.mock("../../../components/hooks/myoxus/diagram-export-svg", () => ({
  materializeDiagramExportSvg: vi.fn(async (svg: string) => svg),
}));
afterEach(() => {
  cleanup();
  sync.next({ ...sync.value, synced: true });
  docStorage.waitForSynced.mockReset().mockResolvedValue();
  vi.restoreAllMocks();
});
function Host({ props }: { props: BpmnBlockPresentationProps }) {
  const [reactToLit, portals] = useLitPortalFactory();
  const anchor = useRef<HTMLDivElement>(null);
  const provider = useMemo(() => {
    const container = new Container();
    const extension = patchBpmnBlockPresentation(reactToLit, docStorage);
    if (typeof extension !== "object" || !("setup" in extension))
      throw new Error("Missing host registration");
    extension.setup(container);
    return container.provider();
  }, [reactToLit]);
  useEffect(() => {
    const target = anchor.current!;
    renderLit(
      provider.get(BpmnBlockPresentationIdentifier).render(props),
      target,
    );
  }, [props, provider]);
  useEffect(() => {
    const target = anchor.current!;
    return () => {
      renderLit(null, target);
    };
  }, []);
  return (
    <>
      <div ref={anchor} />
      {portals.map((portal) => portal.portal)}
    </>
  );
}
test("the real presentation registration mounts Facade controls and dispatches Open instead of a passive Lit placeholder", async () => {
  const open = vi.fn(async () => {}),
    download = vi.fn();
  const props: BpmnBlockPresentationProps = {
    docId: "doc",
    title: "Procurement",
    titleValue: "Procurement",
    readonly: false,
    sourceState: "ready",
    sourceRevision: "source",
    preview: null,
    previewErrorRevision: null,
    loadPreview: vi.fn(async () => null),
    downloads: [{ revision: "source", download }],
    onTitleChange: vi.fn(),
    onOpen: open,
    onRetry: open,
  };
  render(
    <MyoxusUIProvider>
      <I18nextProvider i18n={getOrCreateI18n()}>
        <Host props={props} />
      </I18nextProvider>
    </MyoxusUIProvider>,
  );
  const button = await screen.findByRole("button", { name: "Edit" });
  fireEvent.click(button);
  expect(open).toHaveBeenCalledOnce();
  await waitFor(() =>
    expect((button as HTMLButtonElement).disabled).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Download" }));
  expect(download).toHaveBeenCalledOnce();
  expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe(
    "Procurement",
  );
  expect(
    document.querySelector(
      "[data-myoxus-bpmn-react-root] .mantine-Button-root",
    ),
  ).not.toBeNull();
});

test("the mounted title input projects raw edits instead of the trimmed display fallback", async () => {
  const onTitleChange = vi.fn();
  let props: BpmnBlockPresentationProps = {
    docId: "doc",
    title: "BPMN Diagram",
    titleValue: "",
    readonly: false,
    sourceState: "ready",
    sourceRevision: null,
    preview: null,
    previewErrorRevision: null,
    loadPreview: vi.fn(async () => null),
    downloads: [],
    onTitleChange,
    onOpen: vi.fn(async () => {}),
    onRetry: vi.fn(async () => {}),
  };
  const view = () => (
    <MyoxusUIProvider>
      <I18nextProvider i18n={getOrCreateI18n()}>
        <Host props={props} />
      </I18nextProvider>
    </MyoxusUIProvider>
  );
  const mounted = render(view());
  const input = (await screen.findByRole("textbox")) as HTMLInputElement;
  expect(input.value).toBe("");
  expect(input.placeholder).not.toBe("");
  for (const value of [
    "Purchase",
    "Purchase ",
    "Purchase order",
    "Order",
    "",
  ]) {
    fireEvent.change(input, { target: { value } });
    expect(onTitleChange).toHaveBeenLastCalledWith(value);
    props = { ...props, titleValue: value };
    mounted.rerender(view());
    expect(input.value).toBe(value);
  }
  expect(input.value).toBe("");
});

test("passive previews retain truthful last-good output, reject late completions and release image URLs", async () => {
  const ack = Promise.withResolvers<void>();
  docStorage.waitForSynced.mockReturnValueOnce(ack.promise);
  const stylesheet = document.createElement("style");
  stylesheet.id = "myoxus-branding-css";
  stylesheet.dataset.myoxusBrandingSource = "api";
  document.head.append(stylesheet);
  const urls = vi
    .spyOn(URL, "createObjectURL")
    .mockReturnValueOnce("blob:first")
    .mockReturnValueOnce("blob:last");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const delayed = Promise.withResolvers<Blob | null>();
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg"><text>Review</text><script>alert(1)</script></svg>';
  const load = vi.fn(async (id: string) =>
    id === "slow" ? delayed.promise : new Blob([svg]),
  );
  let props: BpmnBlockPresentationProps = {
    docId: "doc",
    title: "Procurement",
    titleValue: "Procurement",
    readonly: false,
    sourceState: "ready",
    sourceRevision: "first",
    preview: { revision: "first", sourceId: "first" },
    previewErrorRevision: null,
    loadPreview: load,
    downloads: [],
    onTitleChange: vi.fn(),
    onOpen: vi.fn(async () => {}),
    onRetry: vi.fn(async () => {}),
  };
  const view = () => (
    <MyoxusUIProvider>
      <I18nextProvider i18n={getOrCreateI18n()}>
        <Host props={props} />
      </I18nextProvider>
    </MyoxusUIProvider>
  );
  const mounted = render(view());
  try {
    const image = await screen.findByRole("img", { name: "Procurement" });
    expect(image.getAttribute("src")).toBe("blob:first");
    await screen.findByText("Saved locally · sync pending");
    ack.resolve();
    await screen.findByText("Saved");
    sync.next({ ...sync.value, synced: false });
    await screen.findByText("Saved locally · sync pending");
    sync.next({ ...sync.value, synced: true });
    await screen.findByText("Saved");
    expect(image.hasAttribute("tabindex")).toBe(false);
    expect(
      vi.mocked(materializeDiagramExportSvg).mock.calls.at(-1)![0],
    ).not.toContain("script");
    expect(prepareBpmnPreviewSvg).toHaveBeenCalledWith(svg, "first", "first");
    props = {
      ...props,
      sourceRevision: "last",
      preview: { revision: "last", sourceId: "slow" },
    };
    mounted.rerender(view());
    await screen.findByText("Preview is out of date");
    expect(image.getAttribute("src")).toBe("blob:first");
    props = { ...props, preview: { revision: "last", sourceId: "last" } };
    mounted.rerender(view());
    await waitFor(() => expect(image.getAttribute("src")).toBe("blob:last"));
    delayed.resolve(new Blob([svg]));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith("blob:first"));
    expect(urls).toHaveBeenCalledTimes(2);
    expect(image.getAttribute("src")).toBe("blob:last");
    mounted.unmount();
    expect(revoke).toHaveBeenCalledWith("blob:last");
  } finally {
    stylesheet.remove();
  }
});
