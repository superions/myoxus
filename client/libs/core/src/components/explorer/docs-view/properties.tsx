import type { DocCustomPropertyInfo } from "@myoxus/core/modules/db";
import { type DocRecord, DocsService } from "@myoxus/core/modules/doc";
import { WorkspacePropertyService } from "@myoxus/core/modules/workspace-property";
import { useLiveData, useService } from "@myoxus/infra";
import { SurfaceListMeta } from "@myoxus/ui-facade";
import { useContext, useMemo } from "react";

import { SystemPropertyTypes } from "../../system-property-types";
import { WorkspacePropertyTypes } from "../../workspace-property-types";
import { DocExplorerContext } from "../context";
import { generateExplorerPropertyList } from "../properties";
import { getExplorerPropertyDocListPlacement } from "./property-placement";

export type DocListDensity = "compact" | "medium" | "regular";

const listInlinePropertyOrder: string[] = ["updatedAt"];
const cardInlinePropertyOrder: string[] = [
  "createdBy",
  "updatedBy",
  "createdAt",
  "updatedAt",
];

const useProperties = (view: "list" | "card") => {
  const workspacePropertyService = useService(WorkspacePropertyService);

  const propertyList = useLiveData(workspacePropertyService.sortedProperties$);

  const explorerPropertyList = useMemo(() => {
    return generateExplorerPropertyList(propertyList);
  }, [propertyList]);

  const stackProperties = useMemo(
    () =>
      explorerPropertyList
        .filter(
          (property) =>
            getExplorerPropertyDocListPlacement(property) === "stack",
        )
        .filter((p) => p.systemProperty?.type !== "tags"),
    [explorerPropertyList],
  );

  const inlineProperties = useMemo(
    () =>
      explorerPropertyList
        .filter(
          (property) =>
            getExplorerPropertyDocListPlacement(property) === "inline",
        )
        .filter((p) => p.systemProperty?.type !== "tags")
        .sort((a, b) => {
          const orderList =
            view === "list" ? listInlinePropertyOrder : cardInlinePropertyOrder;
          const aIndex = orderList.indexOf(
            a.systemProperty?.type ?? a.workspaceProperty?.type ?? "",
          );
          const bIndex = orderList.indexOf(
            b.systemProperty?.type ?? b.workspaceProperty?.type ?? "",
          );
          // Push un-recognised types to the tail instead of the head
          return (
            (aIndex === -1 ? Number.MAX_SAFE_INTEGER : aIndex) -
            (bIndex === -1 ? Number.MAX_SAFE_INTEGER : bIndex)
          );
        }),
    [explorerPropertyList, view],
  );

  return useMemo(
    () => ({
      stackProperties,
      inlineProperties,
    }),
    [stackProperties, inlineProperties],
  );
};
export const ListViewProperties = ({
  density,
  docId,
}: {
  density: DocListDensity;
  docId: string;
}) => {
  const contextValue = useContext(DocExplorerContext);
  const displayProperties = useLiveData(contextValue?.displayProperties$);
  const docsService = useService(DocsService);
  const doc = useLiveData(docsService.list.doc$(docId));

  const { stackProperties, inlineProperties } = useProperties("list");

  if (!doc) {
    return null;
  }

  return (
    <>
      {/* stack properties */}
      {density === "regular" ? (
        <SurfaceListMeta layout="row-cluster">
          <SurfaceListMeta layout="row-group">
            {stackProperties.map(({ systemProperty, workspaceProperty }) => {
              const displayKey = systemProperty
                ? `system:${systemProperty.type}`
                : workspaceProperty
                  ? `property:${workspaceProperty.id}`
                  : null;
              if (!displayKey || !displayProperties?.includes(displayKey)) {
                return null;
              }
              if (systemProperty && systemProperty.showInDocList) {
                return (
                  <SystemPropertyRenderer
                    doc={doc}
                    config={SystemPropertyTypes[systemProperty.type]}
                    key={systemProperty.type}
                  />
                );
              } else if (
                workspaceProperty &&
                WorkspacePropertyTypes[workspaceProperty.type]?.showInDocList
              ) {
                return (
                  <WorkspacePropertyRenderer
                    key={workspaceProperty.id}
                    doc={doc}
                    property={workspaceProperty}
                    config={WorkspacePropertyTypes[workspaceProperty.type]}
                  />
                );
              }
              return null;
            })}
          </SurfaceListMeta>
          {displayProperties?.includes("system:tags") ? (
            <SurfaceListMeta layout="row-group">
              <SystemPropertyRenderer
                doc={doc}
                config={SystemPropertyTypes.tags}
              />
            </SurfaceListMeta>
          ) : null}
        </SurfaceListMeta>
      ) : null}
      {/* inline properties */}
      {inlineProperties.map(({ systemProperty, workspaceProperty }) => {
        const displayKeys = [
          systemProperty ? `system:${systemProperty.type}` : null,
          workspaceProperty ? `property:${workspaceProperty.id}` : null,
        ];
        if (
          !displayKeys.some((key) => key && displayProperties?.includes(key))
        ) {
          return null;
        }
        if (systemProperty) {
          if (systemProperty.type !== "updatedAt") {
            return null;
          }
          return (
            <SurfaceListMeta
              key={systemProperty.type}
              layout="inline"
              data-myoxus-list-inline-property={systemProperty.type}
            >
              <SystemPropertyRenderer
                doc={doc}
                config={SystemPropertyTypes[systemProperty.type]}
              />
            </SurfaceListMeta>
          );
        } else if (workspaceProperty) {
          const config = WorkspacePropertyTypes[workspaceProperty.type];
          if (!config) {
            return null;
          }
          if (density === "compact") {
            return null;
          }
          return (
            <SurfaceListMeta
              key={workspaceProperty.id}
              layout="inline"
              data-myoxus-list-inline-property={workspaceProperty.type}
            >
              <WorkspacePropertyRenderer
                doc={doc}
                property={workspaceProperty}
                config={config}
              />
            </SurfaceListMeta>
          );
        }
        return null;
      })}
    </>
  );
};

export const CardViewProperties = ({ docId }: { docId: string }) => {
  const contextValue = useContext(DocExplorerContext);
  const displayProperties = useLiveData(contextValue?.displayProperties$);
  const docsService = useService(DocsService);
  const doc = useLiveData(docsService.list.doc$(docId));

  const { stackProperties, inlineProperties } = useProperties("card");

  if (!doc) {
    return null;
  }

  return (
    <SurfaceListMeta layout="card">
      {/* inline properties */}
      {inlineProperties.map(({ systemProperty, workspaceProperty }) => {
        const displayKeys = [
          systemProperty ? `system:${systemProperty.type}` : null,
          workspaceProperty ? `property:${workspaceProperty.id}` : null,
        ];
        if (
          !displayKeys.some((key) => key && displayProperties?.includes(key))
        ) {
          return null;
        }
        if (systemProperty) {
          return (
            <SystemPropertyRenderer
              doc={doc}
              config={SystemPropertyTypes[systemProperty.type]}
              key={systemProperty.type}
            />
          );
        } else if (workspaceProperty) {
          const config = WorkspacePropertyTypes[workspaceProperty.type];
          if (!config) {
            return null;
          }
          return (
            <SurfaceListMeta key={workspaceProperty.id} layout="inline">
              <WorkspacePropertyRenderer
                doc={doc}
                property={workspaceProperty}
                config={config}
              />
            </SurfaceListMeta>
          );
        }
        return null;
      })}
      {/* stack properties */}
      {stackProperties.map(({ systemProperty, workspaceProperty }) => {
        const displayKeys = [
          systemProperty ? `system:${systemProperty.type}` : null,
          workspaceProperty ? `property:${workspaceProperty.id}` : null,
        ];
        if (
          !displayKeys.some((key) => key && displayProperties?.includes(key))
        ) {
          return null;
        }
        if (systemProperty) {
          return (
            <SystemPropertyRenderer
              doc={doc}
              config={SystemPropertyTypes[systemProperty.type]}
              key={systemProperty.type}
            />
          );
        } else if (workspaceProperty) {
          const config = WorkspacePropertyTypes[workspaceProperty.type];
          if (!config) {
            return null;
          }
          return (
            <WorkspacePropertyRenderer
              key={workspaceProperty.id}
              doc={doc}
              property={workspaceProperty}
              config={config}
            />
          );
        }
        return null;
      })}
      {displayProperties?.includes("system:tags") ? (
        <SystemPropertyRenderer doc={doc} config={SystemPropertyTypes.tags} />
      ) : null}
    </SurfaceListMeta>
  );
};

const SystemPropertyRenderer = ({
  doc,
  config,
}: {
  doc: DocRecord;
  config: (typeof SystemPropertyTypes)[string];
}) => {
  if (!config.docListProperty) {
    return null;
  }

  return <config.docListProperty doc={doc} />;
};

const WorkspacePropertyRenderer = ({
  property,
  doc,
  config,
}: {
  property: DocCustomPropertyInfo;
  doc: DocRecord;
  config: (typeof WorkspacePropertyTypes)[keyof typeof WorkspacePropertyTypes];
}) => {
  const customPropertyValue = useLiveData(doc.customProperty$(property.id));
  if (!config.docListProperty) {
    return null;
  }

  return (
    <config.docListProperty
      value={customPropertyValue}
      doc={doc}
      propertyInfo={property}
    />
  );
};
