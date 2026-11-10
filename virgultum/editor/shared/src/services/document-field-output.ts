// SPDX-License-Identifier: AGPL-3.0-or-later
import { createIdentifier } from "@virgultum/global/di";
import type { DocumentField } from "../types/document-field";

/** Host-owned, authorized presentation for a single transient output capture.
 * Never persist these strings or reuse them as field answers or history facts.
 */
export interface DocumentFieldOutputProvider {
  readonly workspaceId: string;
  readonly docId?: string;
  resolve(
    workspaceId: string,
    docId: string,
    fields: readonly DocumentField[],
  ): Promise<readonly string[]>;
}
export const DocumentFieldOutputProvider =
  createIdentifier<DocumentFieldOutputProvider>("DocumentFieldOutputProvider");
