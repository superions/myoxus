import type { DocCustomPropertyInfo } from "@myoxus/core/modules/db";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { WorkspacePropertyService } from "@myoxus/core/modules/workspace-property";
import type { MyoxusDNDData } from "@myoxus/core/types/dnd";
import { useI18n } from "@myoxus/i18n";
import {
  InvisibleIcon,
  MoreHorizontalIcon,
  ViewIcon,
} from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  IconButton,
  Menu,
  PropertyName,
  PropertyRoot,
  PropertyValue,
  PropertyVisibilityContent,
  SurfaceListItemIcon,
  SurfaceListMeta,
  Tooltip,
  useDraggable,
  useDropTarget,
} from "@myoxus/ui-facade";
import { type HTMLProps, useCallback, useState } from "react";

import { useGuard } from "../../guard";
import {
  isSupportedWorkspacePropertyType,
  WorkspacePropertyTypes,
} from "../../workspace-property-types";
import { WorkspacePropertyIcon } from "../icons/workspace-property-icon";
import { EditWorkspacePropertyMenuItems } from "../menu/edit-doc-property";

const PropertyItem = ({
  propertyInfo,
  defaultOpenEditMenu,
  onPropertyInfoChange,
}: {
  propertyInfo: DocCustomPropertyInfo;
  defaultOpenEditMenu?: boolean;
  onPropertyInfoChange?: (
    field: keyof DocCustomPropertyInfo,
    value: string,
  ) => void;
}) => {
  const t = useI18n();
  const workspaceService = useService(WorkspaceService);
  const workspacePropertyService = useService(WorkspacePropertyService);
  const [moreMenuOpen, setMoreMenuOpen] = useState(defaultOpenEditMenu);
  const canEditPropertyInfo = useGuard("Workspace_Properties_Update");

  const typeInfo = isSupportedWorkspacePropertyType(propertyInfo.type)
    ? WorkspacePropertyTypes[propertyInfo.type]
    : undefined;
  const propertyName =
    propertyInfo.name || (typeInfo?.name ? t.t(typeInfo.name) : t["unnamed"]());
  const visibilityLabel =
    propertyInfo.show === "hide-when-empty"
      ? t["com.myoxus.page-properties.property.hide-when-empty"]()
      : propertyInfo.show === "always-hide"
        ? t["com.myoxus.page-properties.property.always-hide"]()
        : t["com.myoxus.page-properties.property.always-show"]();
  const VisibilityIcon =
    propertyInfo.show === "always-hide" ||
    propertyInfo.show === "hide-when-empty"
      ? InvisibleIcon
      : ViewIcon;

  const handleClick = useCallback(() => {
    setMoreMenuOpen(true);
  }, []);

  const { dragRef } = useDraggable<MyoxusDNDData>(
    () => ({
      canDrag: canEditPropertyInfo,
      data: {
        entity: {
          type: "custom-property",
          id: propertyInfo.id,
        },
        from: {
          at: "doc-property:manager",
          workspaceId: workspaceService.workspace.id,
        },
      },
    }),
    [propertyInfo, workspaceService, canEditPropertyInfo],
  );

  const { dropTargetRef, closestEdge } = useDropTarget<MyoxusDNDData>(
    () => ({
      canDrop(data) {
        return (
          !!canEditPropertyInfo &&
          data.source.data.entity?.type === "custom-property" &&
          data.source.data.from?.at === "doc-property:manager" &&
          data.source.data.from?.workspaceId ===
            workspaceService.workspace.id &&
          data.source.data.entity.id !== propertyInfo.id
        );
      },
      closestEdge: {
        allowedEdges: ["top", "bottom"],
      },
      isSticky: true,
      onDrop(data) {
        if (data.source.data.entity?.type !== "custom-property") {
          return;
        }
        const propertyId = data.source.data.entity.id;
        const edge = data.closestEdge;
        if (edge !== "bottom" && edge !== "top") {
          return;
        }
        workspacePropertyService.updatePropertyInfo(propertyId, {
          index: workspacePropertyService.indexAt(
            edge === "bottom" ? "after" : "before",
            propertyInfo.id,
          ),
        });
      },
    }),
    [
      workspacePropertyService,
      propertyInfo,
      workspaceService,
      canEditPropertyInfo,
    ],
  );

  return (
    <Tooltip
      content={t.t(typeInfo?.description || propertyInfo.type)}
      side="left"
    >
      <PropertyRoot
        ref={(elem) => {
          dropTargetRef.current = elem;
          dragRef.current = elem;
        }}
        onClick={handleClick}
        data-myoxus-ui-role="settings-row"
        data-testid="doc-property-manager-item"
        dropIndicatorEdge={closestEdge}
        layout="compact-row"
      >
        <PropertyName
          icon={<WorkspacePropertyIcon propertyInfo={propertyInfo} />}
          name={propertyName}
        />
        <PropertyValue readonly={!canEditPropertyInfo} hoverable={false}>
          <SurfaceListMeta layout="row-cluster">
            <SurfaceListItemIcon
              aria-label={visibilityLabel}
              data-myoxus-ui-role="sidebar-property-visibility-state"
              data-property-visibility={propertyInfo.show ?? "always-show"}
              role="img"
              size="sm"
              title={visibilityLabel}
              tone="tertiary"
            >
              <VisibilityIcon aria-hidden="true" />
            </SurfaceListItemIcon>
            <Menu
              rootOptions={{
                open: moreMenuOpen,
                onOpenChange: setMoreMenuOpen,
                modal: true,
              }}
              items={
                <EditWorkspacePropertyMenuItems
                  propertyId={propertyInfo.id}
                  onPropertyInfoChange={onPropertyInfoChange}
                  readonly={!canEditPropertyInfo}
                />
              }
            >
              <IconButton
                aria-label={propertyName}
                data-myoxus-ui-role="button:icon-only:property-manager"
                icon={<MoreHorizontalIcon />}
              />
            </Menu>
          </SurfaceListMeta>
        </PropertyValue>
      </PropertyRoot>
    </Tooltip>
  );
};

export const WorkspacePropertyManager = ({
  className,
  defaultOpenEditMenuPropertyId,
  onPropertyInfoChange,
  ...props
}: HTMLProps<HTMLDivElement> & {
  defaultOpenEditMenuPropertyId?: string;
  onPropertyInfoChange?: (
    property: DocCustomPropertyInfo,
    field: keyof DocCustomPropertyInfo,
    value: string,
  ) => void;
}) => {
  const workspacePropertyService = useService(WorkspacePropertyService);

  const properties = useLiveData(workspacePropertyService.sortedProperties$);

  return (
    <PropertyVisibilityContent
      collapsible={false}
      className={className}
      {...props}
    >
      {properties.map((propertyInfo) => (
        <PropertyItem
          propertyInfo={propertyInfo}
          defaultOpenEditMenu={
            defaultOpenEditMenuPropertyId === propertyInfo.id
          }
          key={propertyInfo.id}
          onPropertyInfoChange={(...args) =>
            onPropertyInfoChange?.(propertyInfo, ...args)
          }
        />
      ))}
    </PropertyVisibilityContent>
  );
};
