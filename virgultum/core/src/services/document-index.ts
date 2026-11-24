// SPDX-License-Identifier: AGPL-3.0-or-later

import { createIdentifier } from "../primitives/di/index";
import type {
  DocumentIndexProps,
  DocumentIndexBlockModel,
  DocumentIndexQuery,
} from "../models/index";

export type DocumentIndexRow = { title: string; href: string };
export type DocumentIndexTable = {
  headers: string[];
  rows: { text: string; href?: string }[][];
};
export interface DocumentIndexOutputProvider {
  resolveTable(
    props: DocumentIndexProps,
    workspaceId?: string,
  ): Promise<DocumentIndexTable>;
  resolve(
    query: DocumentIndexQuery,
    workspaceId?: string,
  ): Promise<DocumentIndexRow[]>;
  readonly emptyText: string;
}
export const DocumentIndexOutputProvider =
  createIdentifier<DocumentIndexOutputProvider>("DocumentIndexOutputProvider");
export interface DocumentIndexHost {
  mount(anchor: HTMLElement, model: DocumentIndexBlockModel): () => void;
  configure(
    anchor: HTMLElement,
    props: DocumentIndexProps,
    apply: (value: DocumentIndexProps) => void,
    close: () => void,
    docId: string,
  ): () => void;
}
export const DocumentIndexHost =
  createIdentifier<DocumentIndexHost>("DocumentIndexHost");
