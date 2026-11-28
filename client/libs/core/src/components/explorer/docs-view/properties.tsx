// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { DocCustomPropertyInfo } from "@myoxus/core/modules/db";
import { type DocRecord, DocsService } from "@myoxus/core/modules/doc";
import { WorkspacePropertyService } from "@myoxus/core/modules/workspace-property";
import { useLiveData, useService } from "@myoxus/infra";
import { SurfaceListMeta } from "@myoxus/ui-facade";
import { useContext, useMemo } from "react";

import { SystemPropertyTypes } from "../../system-property-types";
import { WorkspacePropertyTypes } from "../../workspace-property-types";
import { DocExplorerContext } from "../context";
import {
  type ExplorerPropertyEntry,
  generateExplorerPropertyList,
} from "../properties";
import { getExplorerPropertyDocListPlacement } from "./property-placement";

export type DocListDensity = "compact" | "medium" | "regular";

const LIST_INLINE_ORDER = ["updatedAt"];
const CARD_INLINE_ORDER = ["createdBy", "updatedBy", "createdAt", "updatedAt"];

const useExplorerDocProperties = (view: "list" | "card") => {
  const properties = useLiveData(
    useService(WorkspacePropertyService).sortedProperties$,
  );

  return useMemo(() => {
    const entries = generateExplorerPropertyList(properties);
    const order = view === "list" ? LIST_INLINE_ORDER : CARD_INLINE_ORDER;

    const stackProperties = entries.filter(
      (entry) =>
        getExplorerPropertyDocListPlacement(entry) === "stack" &&
        entry.systemProperty?.type !== "tags",
    );

    const inlineProperties = entries
      .filter(
        (entry) =>
          getExplorerPropertyDocListPlacement(entry) === "inline" &&
          entry.systemProperty?.type !== "tags",
      )
      .sort((a, b) => {
        const keyA = a.systemProperty?.type ?? a.workspaceProperty?.type ?? "";
        const keyB = b.systemProperty?.type ?? b.workspaceProperty?.type ?? "";
        const idxA = order.indexOf(keyA);
        const idxB = order.indexOf(keyB);
        return (
          (idxA === -1 ? Number.MAX_SAFE_INTEGER : idxA) -
          (idxB === -1 ? Number.MAX_SAFE_INTEGER : idxB)
        );
      });

    return { stackProperties, inlineProperties };
  }, [properties, view]);
};

const isEntryVisible = (
  entry: ExplorerPropertyEntry,
  displayProperties: readonly string[] | undefined,
): boolean => {
  if (!displayProperties) return false;
  if (
    entry.systemProperty &&
    displayProperties.includes(`system:${entry.systemProperty.type}`)
  ) {
    return true;
  }
  if (
    entry.workspaceProperty &&
    displayProperties.includes(`property:${entry.workspaceProperty.id}`)
  ) {
    return true;
  }
  return false;
};

const SystemDocProperty = ({ doc, type }: { doc: DocRecord; type: string }) => {
  const Component = SystemPropertyTypes[type]?.docListProperty;
  return Component ? <Component doc={doc} /> : null;
};

const CustomDocProperty = ({
  doc,
  property,
}: {
  doc: DocRecord;
  property: DocCustomPropertyInfo;
}) => {
  const value = useLiveData(doc.customProperty$(property.id));
  const Component = WorkspacePropertyTypes[property.type]?.docListProperty;
  return Component ? (
    <Component value={value} doc={doc} propertyInfo={property} />
  ) : null;
};

export const ListViewProperties = ({
  density,
  docId,
}: {
  density: DocListDensity;
  docId: string;
}) => {
  const displayProperties = useLiveData(
    useContext(DocExplorerContext)?.displayProperties$,
  );
  const doc = useLiveData(useService(DocsService).list.doc$(docId));
  const { stackProperties, inlineProperties } =
    useExplorerDocProperties("list");

  if (!doc) {
    return null;
  }

  return (
    <>
      {density === "regular" ? (
        <SurfaceListMeta layout="row-cluster">
          <SurfaceListMeta layout="row-group">
            {stackProperties.map((entry) => {
              const key = entry.systemProperty
                ? `system:${entry.systemProperty.type}`
                : entry.workspaceProperty
                  ? `property:${entry.workspaceProperty.id}`
                  : null;
              if (!key || !displayProperties?.includes(key)) return null;

              if (entry.systemProperty?.showInDocList) {
                return (
                  <SystemDocProperty
                    key={entry.systemProperty.type}
                    doc={doc}
                    type={entry.systemProperty.type}
                  />
                );
              }
              if (
                entry.workspaceProperty &&
                WorkspacePropertyTypes[entry.workspaceProperty.type]
                  ?.showInDocList
              ) {
                return (
                  <CustomDocProperty
                    key={entry.workspaceProperty.id}
                    doc={doc}
                    property={entry.workspaceProperty}
                  />
                );
              }
              return null;
            })}
          </SurfaceListMeta>
          {displayProperties?.includes("system:tags") ? (
            <SurfaceListMeta layout="row-group">
              <SystemDocProperty doc={doc} type="tags" />
            </SurfaceListMeta>
          ) : null}
        </SurfaceListMeta>
      ) : null}

      {inlineProperties.map((entry) => {
        if (!isEntryVisible(entry, displayProperties)) return null;

        if (entry.systemProperty) {
          if (entry.systemProperty.type !== "updatedAt") return null;
          return (
            <SurfaceListMeta
              key={entry.systemProperty.type}
              layout="inline"
              data-myoxus-list-inline-property={entry.systemProperty.type}
            >
              <SystemDocProperty doc={doc} type={entry.systemProperty.type} />
            </SurfaceListMeta>
          );
        }

        if (
          entry.workspaceProperty &&
          density !== "compact" &&
          WorkspacePropertyTypes[entry.workspaceProperty.type]
        ) {
          return (
            <SurfaceListMeta
              key={entry.workspaceProperty.id}
              layout="inline"
              data-myoxus-list-inline-property={entry.workspaceProperty.type}
            >
              <CustomDocProperty doc={doc} property={entry.workspaceProperty} />
            </SurfaceListMeta>
          );
        }

        return null;
      })}
    </>
  );
};

export const CardViewProperties = ({ docId }: { docId: string }) => {
  const displayProperties = useLiveData(
    useContext(DocExplorerContext)?.displayProperties$,
  );
  const doc = useLiveData(useService(DocsService).list.doc$(docId));
  const { stackProperties, inlineProperties } =
    useExplorerDocProperties("card");

  if (!doc) {
    return null;
  }

  return (
    <SurfaceListMeta layout="card">
      {inlineProperties.map((entry) => {
        if (!isEntryVisible(entry, displayProperties)) return null;
        if (entry.systemProperty) {
          return (
            <SystemDocProperty
              key={entry.systemProperty.type}
              doc={doc}
              type={entry.systemProperty.type}
            />
          );
        }
        if (
          entry.workspaceProperty &&
          WorkspacePropertyTypes[entry.workspaceProperty.type]
        ) {
          return (
            <SurfaceListMeta key={entry.workspaceProperty.id} layout="inline">
              <CustomDocProperty doc={doc} property={entry.workspaceProperty} />
            </SurfaceListMeta>
          );
        }
        return null;
      })}

      {stackProperties.map((entry) => {
        if (!isEntryVisible(entry, displayProperties)) return null;
        if (entry.systemProperty) {
          return (
            <SystemDocProperty
              key={entry.systemProperty.type}
              doc={doc}
              type={entry.systemProperty.type}
            />
          );
        }
        if (
          entry.workspaceProperty &&
          WorkspacePropertyTypes[entry.workspaceProperty.type]
        ) {
          return (
            <CustomDocProperty
              key={entry.workspaceProperty.id}
              doc={doc}
              property={entry.workspaceProperty}
            />
          );
        }
        return null;
      })}

      {displayProperties?.includes("system:tags") ? (
        <SystemDocProperty doc={doc} type="tags" />
      ) : null}
    </SurfaceListMeta>
  );
};
