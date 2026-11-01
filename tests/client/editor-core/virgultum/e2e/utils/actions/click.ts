import type { Page } from "@playwright/test";
import type { IPoint } from "@virgultum/global/gfx";
import type { Store } from "@virgultum/store";

async function toViewCoord(page: Page, point: number[]) {
  return page.evaluate((point) => {
    const container = document.querySelector("myoxus-edgeless-root");
    if (!container) throw new Error("container not found");
    return container.service.viewport.toViewCoord(point[0], point[1]);
  }, point);
}

export async function moveView(page: Page, point: [number, number]) {
  const [x, y] = await toViewCoord(page, point);
  await page.mouse.move(x, y);
}

export async function click(page: Page, point: IPoint) {
  await page.mouse.click(point.x, point.y);
}

export async function clickView(page: Page, point: [number, number]) {
  const [x, y] = await toViewCoord(page, point);
  await page.mouse.click(x, y);
}

export async function dblclickView(page: Page, point: [number, number]) {
  const [x, y] = await toViewCoord(page, point);
  await page.mouse.dblclick(x, y);
}

export async function clickBlockById(page: Page, id: string) {
  await page.click(`[data-block-id="${id}"]`);
}

export async function doubleClickBlockById(page: Page, id: string) {
  await page.dblclick(`[data-block-id="${id}"]`);
}

export async function addNewPage(page: Page, title = "") {
  // The isolated editor has no Core title-to-metadata synchronizer. Seed both
  // inputs of the reference consumer; do not emulate that application owner.
  const docMeta = await page.evaluate((title) => {
    const { collection, $virgultum } = window;
    const doc = collection.createDoc().getStore();
    doc.load(() => {
      const rootId = doc.addBlock("myoxus:page", {
        title: new $virgultum.store.Text(title),
      });
      doc.addBlock("myoxus:surface", {}, rootId);
      const noteId = doc.addBlock("myoxus:note", {}, rootId);
      doc.addBlock("myoxus:paragraph", {}, noteId);
    });
    collection.meta.setDocMeta(doc.id, { title });
    doc.resetHistory();

    return collection.meta.docMetas.find((meta) => meta.id === doc.id);
  }, title);
  if (!docMeta) throw new Error("Add new doc failed");
  return docMeta;
}

export async function switchToPage(page: Page, docId?: string) {
  await page.evaluate((docId) => {
    const { collection, editor } = window;

    if (!docId) {
      const docMetas = collection.meta.docMetas;
      if (!docMetas.length) return;
      docId = docMetas[0].id;
    }

    const doc = collection.getDoc(docId)?.getStore();
    if (!doc) return;
    editor.doc = doc;
  }, docId);
}

export async function switchReadonly(page: Page, value = true) {
  await page.evaluate((_value) => {
    const defaultPage = document.querySelector(
      "myoxus-page-root,myoxus-edgeless-root",
    ) as HTMLElement & {
      store: Store;
    };
    const store = defaultPage.store;
    store.readonly = _value;
  }, value);
}

export async function activeEmbed(page: Page) {
  await page.click(".resizable-img");
}
