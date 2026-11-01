import { dragBetweenCoords } from "../utils/actions/drag.js";
import {
  getNoteBoundBoxInEdgeless,
  setEdgelessTool,
  switchEditorMode,
} from "../utils/actions/edgeless.js";
import {
  enterPlaygroundRoom,
  initEmptyEdgelessState,
} from "../utils/actions/misc.js";
import { assertBlockCount } from "../utils/asserts.js";
import { test } from "../utils/playwright.js";

test("erase note", async ({ page }) => {
  await enterPlaygroundRoom(page);
  const { noteId } = await initEmptyEdgelessState(page);
  await switchEditorMode(page);
  await assertBlockCount(page, "edgeless-note", 1);

  await setEdgelessTool(page, "eraser");
  const box = await getNoteBoundBoxInEdgeless(page, noteId);
  await dragBetweenCoords(
    page,
    { x: 0, y: 0 },
    { x: box.x + 10, y: box.y + 10 },
  );
  await assertBlockCount(page, "edgeless-note", 0);
});
