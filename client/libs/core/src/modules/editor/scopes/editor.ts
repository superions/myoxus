import { Scope } from "@myoxus/infra";

import type { Editor } from "../entities/editor";

export class EditorScope extends Scope<{
  editor: Editor;
}> {}
