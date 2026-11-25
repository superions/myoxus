// SPDX-License-Identifier: AGPL-3.0-or-later
import { lazy, useLayoutEffect, useState, useMemo } from "react";
import { useService, useServiceOptional, useLiveData } from "@myoxus/infra";
import { PublicUserService } from "../../../modules/server";
import { useI18n } from "@myoxus/i18n";
import { MyoxusPageReference } from "../../../components/myoxus/reference-link";
import { CoreDocEmbedProvider, DocsService } from "../../../modules/doc";
import { WorkspaceService } from "../../../modules/workspace";
import { GuardService } from "../../../modules/permissions";
import { toDocSearchParams } from "../../../modules/navigation";
import { AnnotationInline } from "../../view-extensions/editor-view/annotation";
import {
  getAnnotationRanges,
  type ReferenceInfo,
} from "@virgultum/core/models";
import type { PageLine } from "./plain-page-model";
import { restorePageRange } from "./plain-page-input";
import * as Y from "yjs";

export type PageInlineObject =
  | {
      kind: "citation";
      value: import("@virgultum/core/models").CitationFootNote;
      start: Y.RelativePosition;
    }
  | {
      kind: "field";
      value: import("@virgultum/core/types").DocumentField;
      start: Y.RelativePosition;
    }
  | { kind: "latex"; source: string; start: Y.RelativePosition }
  | { kind: "mention"; member: string }
  | { kind: "footnote"; id: string; start: Y.RelativePosition }
  | { kind: "reference"; reference: ReferenceInfo }
  | { kind: "annotation"; id: string; body: string; start: Y.RelativePosition };

const Marker = lazy(async () => ({
  default: (await import("./page-footnote")).Marker,
}));
const Citation = lazy(() => import("./page-citation"));
const InputField = lazy(async () => ({
  default: (await import("../../view-extensions/editor-view/document-field"))
    .PageDocumentField,
}));
const InlineEquation = lazy(async () => ({
  default: (await import("./page-equation")).InlineEquation,
}));
function Mention({ id }: { id: string }) {
  const service = useServiceOptional(PublicUserService),
    t = useI18n();
  const user = useLiveData(
    useMemo(() => service?.publicUser$(id), [service, id]),
  );
  const pending = useLiveData(
    useMemo(() => service?.isLoading$(id), [service, id]),
  );
  useLayoutEffect(() => {
    service?.revalidate(id);
  }, [service, id]);
  return (
    <span
      data-page-member={
        user?.removed
          ? "removed"
          : user
            ? "ready"
            : pending
              ? "loading"
              : "unknown"
      }
    >
      @
      {user?.removed
        ? t["com.myoxus.inactive-member"]()
        : (user?.name ?? (pending ? t.Loading() : t["Unknown User"]()))}
    </span>
  );
}
function Reference({ reference }: { reference: ReferenceInfo }) {
  const guard = useService(GuardService),
    docs = useService(DocsService),
    workspace = useService(WorkspaceService).workspace;
  const { pageId, workspaceId, params, title } = reference;
  const [target, setTarget] = useState<{
    pageId: string;
    workspaceId?: string;
    resolved: ReturnType<
      CoreDocEmbedProvider["openReference"]
    >["target"]["value"];
  }>();
  useLayoutEffect(() => {
    const access = new CoreDocEmbedProvider(guard, docs, workspace);
    const binding = access.openReference(workspaceId, pageId);
    const stop = binding.target.subscribe((resolved) =>
      setTarget({ pageId, workspaceId, resolved }),
    );
    return () => {
      stop();
      binding.dispose();
      access.dispose();
    };
  }, [workspace, docs, guard, pageId, workspaceId]);
  const current =
    target?.pageId === pageId && target.workspaceId === workspaceId
      ? target.resolved
      : undefined;
  const search = useMemo(() => toDocSearchParams(params), [params]);
  return (
    <MyoxusPageReference
      pageId={current?.docId ?? pageId}
      workspaceId={current?.collection.id ?? workspaceId}
      params={search}
      title={title}
      resolutionState={
        current === undefined
          ? "checking"
          : current === null
            ? "unavailable"
            : undefined
      }
    />
  );
}

export default function PageInline({
  object,
  line,
  readonly,
  field,
}: {
  object: PageInlineObject;
  line: PageLine;
  readonly: boolean;
  field: HTMLElement;
}) {
  if (object.kind === "reference")
    return <Reference reference={object.reference} />;
  if (object.kind === "citation")
    return (
      <Citation object={object} line={line} field={field} readonly={readonly} />
    );
  if (object.kind === "field")
    return (
      <InputField
        line={line}
        object={object}
        element={field}
        readonly={readonly}
      />
    );
  if (object.kind === "mention") return <Mention id={object.member} />;
  if (object.kind === "latex")
    return (
      <InlineEquation
        key={object.source}
        object={object}
        field={field}
        line={line}
        readonly={readonly}
      />
    );
  if (object.kind === "footnote")
    return (
      <Marker line={line} field={field} id={object.id} point={object.start} />
    );
  const { model, text } = line,
    store = model.store;
  const lookup = () => {
    if (!field.isConnected || store.getModelById(model.id) !== model) return;
    const pos = Y.createAbsolutePositionFromRelativePosition(
      object.start,
      store.spaceDoc,
    );
    if (!pos || pos.type !== text) return;
    return getAnnotationRanges(text.toDelta()).find(
      (r) => r.id === object.id && r.index === pos.index,
    );
  };
  const caret = (offset: number) => {
    const root = field.closest<HTMLElement>("[data-page-renderer]");
    if (!root) return;
    root
      .querySelector<HTMLElement>("[data-page-body]")
      ?.focus({ preventScroll: true });
    const point = { id: model.id, offset };
    restorePageRange(root, { anchor: point, focus: point });
  };
  const apply = (body: string, expected: string) => {
    const range = lookup();
    if (
      !range ||
      readonly ||
      store.readonly ||
      range.body !== expected ||
      (model.flavour === "myoxus:table"
        ? Boolean(field.closest('[data-cell-protected="fixed"]'))
        : store.hasFixedText(model))
    )
      return false;
    if (body === expected) return true;
    store.captureSync();
    store.transact(() => {
      text.delete(range.index, range.length);
      if (body)
        text.insert(range.index, body, { annotation: { id: range.id } });
    });
    store.captureSync();
    if (!body) queueMicrotask(() => caret(range.index));
    return true;
  };
  return (
    <AnnotationInline
      id={object.id}
      body={object.body}
      readonly={readonly}
      apply={apply}
      remove={(expected) => apply("", expected)}
      focusEditor={(side) => {
        const range = lookup();
        if (range) caret(range.index + (side === "after" ? range.length : 0));
      }}
    />
  );
}
