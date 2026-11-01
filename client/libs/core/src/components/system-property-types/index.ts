import type { FilterParams } from "@myoxus/core/modules/collection-rules";
import type { DocRecord } from "@myoxus/core/modules/doc";
import type { I18nString } from "@myoxus/i18n";
import {
  CloudWorkspaceIcon,
  DatabaseIcon,
  DateTimeIcon,
  EdgelessIcon,
  FavoriteIcon,
  FileIcon,
  HistoryIcon,
  IntegrationsIcon,
  LongerIcon,
  MemberIcon,
  TagIcon,
  TemplateIcon,
  TitleIcon,
} from "@myoxus/icons/react";

import type { GroupHeaderProps } from "../explorer/types";
import { DateFilterMethod } from "../workspace-property-types";
import { TextFilterValue } from "../workspace-property-types/text";
import {
  CreateAtDocListProperty,
  CreatedAtFilterValue,
  CreatedAtGroupHeader,
  UpdatedAtDocListProperty,
  UpdatedAtFilterValue,
  UpdatedAtGroupHeader,
} from "./created-updated-at";
import {
  CreatedByDocListInlineProperty,
  CreatedByUpdatedByFilterValue,
  ModifiedByGroupHeader,
  UpdatedByDocListInlineProperty,
} from "./created-updated-by";
import {
  DocumentClassificationDocListProperty,
  DocumentClassificationGroupHeader,
  DocumentMetadataFilterValue,
  DocumentReviewDueAtDocListProperty,
  DocumentReviewDueAtGroupHeader,
  DocumentStatusDocListProperty,
  DocumentStatusGroupHeader,
  DocumentTypeDocListProperty,
  DocumentTypeGroupHeader,
  DocumentValidUntilDocListProperty,
  DocumentValidUntilGroupHeader,
  DocumentVersionDocListProperty,
  DocumentVersionGroupHeader,
} from "./document-metadata";
import {
  EdgelessThemeDocListProperty,
  EdgelessThemeFilterValue,
  EdgelessThemeGroupHeader,
} from "./edgeless-theme";
import { FavoriteFilterValue } from "./favorite";
import {
  IntegrationTypeDocListProperty,
  IntegrationTypeFilterValue,
  IntegrationTypeGroupHeader,
} from "./integration-type";
import { PageKindFilterValue } from "./page-kind";
import {
  PageWidthDocListProperty,
  PageWidthFilterValue,
  PageWidthGroupHeader,
} from "./page-width";
import { SharedFilterValue } from "./shared";
import {
  TagsDocListProperty,
  TagsFilterValue,
  TagsGroupActions,
  TagsGroupHeader,
} from "./tags";
import {
  TemplateDocListProperty,
  TemplateFilterValue,
  TemplateGroupHeader,
} from "./template";

export const SystemPropertyTypes = {
  title: {
    icon: TitleIcon,
    name: "Title",
    allowInOrderBy: true,
    filterMethod: {
      match: "com.myoxus.filter.contains",
    },
    filterValue: TextFilterValue,
    defaultFilter: { method: "match", value: "" },
  },
  tags: {
    icon: TagIcon,
    name: "Tags",
    filterMethod: {
      "include-all": "com.myoxus.filter.contains all",
      "include-any-of": "com.myoxus.filter.contains one of",
      "not-include-all": "com.myoxus.filter.does not contains all",
      "not-include-any-of": "com.myoxus.filter.does not contains one of",
      "is-not-empty": "com.myoxus.filter.is not empty",
      "is-empty": "com.myoxus.filter.is empty",
    },
    filterValue: TagsFilterValue,
    allowInGroupBy: true,
    allowInOrderBy: true,
    defaultFilter: { method: "is-not-empty" },
    showInDocList: "stack",
    docListProperty: TagsDocListProperty,
    groupHeader: TagsGroupHeader,
    groupActions: TagsGroupActions,
  },
  createdBy: {
    icon: MemberIcon,
    name: "com.myoxus.page-properties.property.createdBy",
    allowInGroupBy: true,
    allowInOrderBy: true,
    filterMethod: {
      include: "com.myoxus.filter.contains all",
    },
    filterValue: CreatedByUpdatedByFilterValue,
    defaultFilter: { method: "include", value: "" },
    showInDocList: "inline",
    docListProperty: CreatedByDocListInlineProperty,
    groupHeader: ModifiedByGroupHeader,
  },
  updatedBy: {
    icon: MemberIcon,
    name: "com.myoxus.page-properties.property.updatedBy",
    allowInGroupBy: true,
    allowInOrderBy: true,
    filterMethod: {
      include: "com.myoxus.filter.contains all",
    },
    filterValue: CreatedByUpdatedByFilterValue,
    defaultFilter: { method: "include", value: "" },
    showInDocList: "inline",
    docListProperty: UpdatedByDocListInlineProperty,
    groupHeader: ModifiedByGroupHeader,
  },
  updatedAt: {
    icon: DateTimeIcon,
    name: "com.myoxus.page-properties.property.updatedAt",
    allowInGroupBy: true,
    allowInOrderBy: true,
    filterMethod: {
      ...DateFilterMethod,
    },
    filterValue: UpdatedAtFilterValue,
    defaultFilter: { method: "this-week" },
    showInDocList: "inline",
    docListProperty: UpdatedAtDocListProperty,
    groupHeader: UpdatedAtGroupHeader,
  },
  createdAt: {
    icon: HistoryIcon,
    name: "com.myoxus.page-properties.property.createdAt",
    allowInGroupBy: true,
    allowInOrderBy: true,
    filterMethod: {
      ...DateFilterMethod,
    },
    filterValue: CreatedAtFilterValue,
    defaultFilter: { method: "this-week" },
    showInDocList: "inline",
    docListProperty: CreateAtDocListProperty,
    groupHeader: CreatedAtGroupHeader,
  },
  favorite: {
    icon: FavoriteIcon,
    name: "Favorited",
    filterMethod: {
      is: "com.myoxus.filter.is",
    },
    filterValue: FavoriteFilterValue,
  },
  pageKind: {
    icon: DatabaseIcon,
    name: "com.myoxus.workspace-pages.kind.label",
    filterMethod: {
      is: "com.myoxus.filter.is",
    },
    filterValue: PageKindFilterValue,
    defaultFilter: { method: "is", value: "all" },
    allPagesOnly: true,
  },
  shared: {
    icon: CloudWorkspaceIcon,
    name: "Shared",
    filterMethod: {
      is: "com.myoxus.filter.is",
    },
    filterValue: SharedFilterValue,
  },
  edgelessTheme: {
    icon: EdgelessIcon,
    name: "com.myoxus.page-properties.property.edgelessTheme",
    showInDocList: "stack",
    allowInGroupBy: true,
    allowInOrderBy: true,
    docListProperty: EdgelessThemeDocListProperty,
    groupHeader: EdgelessThemeGroupHeader,
    filterMethod: {
      is: "com.myoxus.editCollection.rules.include.is",
      "is-not": "com.myoxus.editCollection.rules.include.is-not",
    },
    filterValue: EdgelessThemeFilterValue,
    defaultFilter: { method: "is", value: "system" },
  },
  pageWidth: {
    icon: LongerIcon,
    name: "com.myoxus.page-properties.property.pageWidth",
    showInDocList: "stack",
    allowInGroupBy: true,
    allowInOrderBy: true,
    docListProperty: PageWidthDocListProperty,
    groupHeader: PageWidthGroupHeader,
    filterMethod: {
      is: "com.myoxus.editCollection.rules.include.is",
      "is-not": "com.myoxus.editCollection.rules.include.is-not",
    },
    filterValue: PageWidthFilterValue,
    defaultFilter: { method: "is", value: "fullWidth" },
  },
  status: {
    icon: HistoryIcon,
    name: "Status",
    showInDocList: "stack",
    allowInGroupBy: true,
    allowInOrderBy: true,
    docListProperty: DocumentStatusDocListProperty,
    groupHeader: DocumentStatusGroupHeader,
    filterMethod: {
      is: "com.myoxus.editCollection.rules.include.is",
      "is-not": "com.myoxus.editCollection.rules.include.is-not",
      "is-not-empty": "com.myoxus.filter.is not empty",
      "is-empty": "com.myoxus.filter.is empty",
    },
    filterValue: DocumentMetadataFilterValue,
    defaultFilter: { method: "is-not-empty" },
  },
  documentType: {
    icon: FileIcon,
    name: "com.myoxus.document-metadata.field.document-type",
    showInDocList: "stack",
    allowInGroupBy: true,
    allowInOrderBy: true,
    docListProperty: DocumentTypeDocListProperty,
    groupHeader: DocumentTypeGroupHeader,
    filterMethod: {
      is: "com.myoxus.editCollection.rules.include.is",
      "is-not": "com.myoxus.editCollection.rules.include.is-not",
      "is-not-empty": "com.myoxus.filter.is not empty",
      "is-empty": "com.myoxus.filter.is empty",
    },
    filterValue: DocumentMetadataFilterValue,
    defaultFilter: { method: "is-not-empty" },
  },
  version: {
    icon: HistoryIcon,
    name: "Version",
    showInDocList: "stack",
    allowInGroupBy: true,
    allowInOrderBy: true,
    docListProperty: DocumentVersionDocListProperty,
    groupHeader: DocumentVersionGroupHeader,
    filterMethod: {
      is: "com.myoxus.editCollection.rules.include.is",
      "is-not": "com.myoxus.editCollection.rules.include.is-not",
      "is-not-empty": "com.myoxus.filter.is not empty",
      "is-empty": "com.myoxus.filter.is empty",
    },
    filterValue: DocumentMetadataFilterValue,
    defaultFilter: { method: "is-not-empty" },
  },
  classification: {
    icon: TagIcon,
    name: "com.myoxus.document-metadata.field.classification",
    showInDocList: "stack",
    allowInGroupBy: true,
    allowInOrderBy: true,
    docListProperty: DocumentClassificationDocListProperty,
    groupHeader: DocumentClassificationGroupHeader,
    filterMethod: {
      is: "com.myoxus.editCollection.rules.include.is",
      "is-not": "com.myoxus.editCollection.rules.include.is-not",
      "is-not-empty": "com.myoxus.filter.is not empty",
      "is-empty": "com.myoxus.filter.is empty",
    },
    filterValue: DocumentMetadataFilterValue,
    defaultFilter: { method: "is-not-empty" },
  },
  reviewDueAt: {
    icon: DateTimeIcon,
    name: "com.myoxus.document-metadata.field.review-due-at",
    showInDocList: "inline",
    allowInGroupBy: true,
    allowInOrderBy: true,
    docListProperty: DocumentReviewDueAtDocListProperty,
    groupHeader: DocumentReviewDueAtGroupHeader,
    filterMethod: {
      before: "com.myoxus.filter.before",
      after: "com.myoxus.filter.after",
      "is-not-empty": "com.myoxus.filter.is not empty",
      "is-empty": "com.myoxus.filter.is empty",
    },
    filterValue: DocumentMetadataFilterValue,
    defaultFilter: { method: "is-not-empty" },
  },
  validUntil: {
    icon: DateTimeIcon,
    name: "com.myoxus.document-metadata.field.valid-until",
    showInDocList: "inline",
    allowInGroupBy: true,
    allowInOrderBy: true,
    docListProperty: DocumentValidUntilDocListProperty,
    groupHeader: DocumentValidUntilGroupHeader,
    filterMethod: {
      before: "com.myoxus.filter.before",
      after: "com.myoxus.filter.after",
      "is-not-empty": "com.myoxus.filter.is not empty",
      "is-empty": "com.myoxus.filter.is empty",
    },
    filterValue: DocumentMetadataFilterValue,
    defaultFilter: { method: "is-not-empty" },
  },
  template: {
    icon: TemplateIcon,
    name: "com.myoxus.page-properties.property.template",
    showInDocList: "stack",
    allowInGroupBy: true,
    allowInOrderBy: true,
    docListProperty: TemplateDocListProperty,
    groupHeader: TemplateGroupHeader,
    filterMethod: {
      is: "com.myoxus.editCollection.rules.include.is",
      "is-not": "com.myoxus.editCollection.rules.include.is-not",
    },
    filterValue: TemplateFilterValue,
    defaultFilter: { method: "is", value: "true" },
  },
  integrationType: {
    icon: IntegrationsIcon,
    name: "com.myoxus.integration.integrations",
    showInDocList: "stack",
    allowInGroupBy: true,
    allowInOrderBy: true,
    docListProperty: IntegrationTypeDocListProperty,
    groupHeader: IntegrationTypeGroupHeader,
    filterMethod: {
      is: "com.myoxus.editCollection.rules.include.is",
      "is-not": "com.myoxus.editCollection.rules.include.is-not",
    },
    filterValue: IntegrationTypeFilterValue,
    defaultFilter: { method: "is", value: "readwise" },
  },
} as {
  [type: string]: {
    icon: React.FC<React.SVGProps<SVGSVGElement>>;
    name: I18nString;

    allowInOrderBy?: boolean;
    allowInGroupBy?: boolean;
    allPagesOnly?: boolean;
    filterMethod?: { [key: string]: I18nString };
    filterValue?: React.FC<{
      filter: FilterParams;
      isDraft?: boolean;
      onDraftCompleted?: () => void;
      onChange?: (filter: FilterParams) => void;
    }>;
    defaultFilter?: Omit<FilterParams, "type" | "key">;
    /**
     * Whether to show the property in the doc list,
     * - `inline`: show the property in the doc list inline
     * - `stack`: show as tags
     */
    showInDocList?: "inline" | "stack";
    docListProperty?: React.FC<{ doc: DocRecord }>;
    groupHeader?: React.FC<GroupHeaderProps>;
    groupActions?: React.FC<{ groupId: string }>;
  };
};

export type SystemPropertyType = keyof typeof SystemPropertyTypes;

export const isSupportedSystemPropertyType = (type?: string) => {
  return type ? type in SystemPropertyTypes : false;
};
