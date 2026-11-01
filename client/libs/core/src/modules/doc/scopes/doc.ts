import { Scope } from "@myoxus/infra";
import type { Store } from "@virgultum/editor/store";

import type { DocRecord } from "../entities/record";

export class DocScope extends Scope<{
  docId: string;
  record: DocRecord;
  virgultumDoc: Store;
}> {}
