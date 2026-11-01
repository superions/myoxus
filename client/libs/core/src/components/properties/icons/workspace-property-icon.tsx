import type { DocCustomPropertyInfo } from "@myoxus/core/modules/db";
import {
  AiIcon,
  EmailIcon,
  TextIcon,
  DateTimeIcon,
  KeyboardIcon,
  PenIcon,
  AccountIcon,
  EmbedWebIcon,
  LayerIcon,
  PinIcon,
  AppearanceIcon,
  EraserIcon,
  LayoutIcon,
  PresentationIcon,
  BookmarkIcon,
  ExportToHtmlIcon,
  LightModeIcon,
  ProgressIcon,
  BulletedListIcon,
  ExportToMarkdownIcon,
  LinkIcon,
  PublishIcon,
  CameraIcon,
  ExportToPdfIcon,
  LinkedEdgelessIcon,
  QuoteIcon,
  CheckBoxCheckLinearIcon,
  ExportToPngIcon,
  LinkedPageIcon,
  SaveIcon,
  CloudWorkspaceIcon,
  ExportToSvgIcon,
  LocalDataIcon,
  ShapeIcon,
  CodeIcon,
  FavoriteIcon,
  LocalWorkspaceIcon,
  StyleIcon,
  CodeBlockIcon,
  FileIcon,
  LockIcon,
  TagIcon,
  CollaborationIcon,
  FolderIcon,
  MultiSelectIcon,
  TagsIcon,
  ColorPickerIcon,
  FrameIcon,
  NewIcon,
  TodayIcon,
  ContactWithUsIcon,
  GridIcon,
  NowIcon,
  UpgradeIcon,
  DarkModeIcon,
  GroupingIcon,
  NumberIcon,
  UserGuideIcon,
  DatabaseKanbanViewIcon,
  ImageIcon,
  NumberedListIcon,
  ViewIcon,
  DatabaseListViewIcon,
  InboxIcon,
  OtherIcon,
  ViewLayersIcon,
  DatabaseTableViewIcon,
  InfoIcon,
  PageIcon,
  AttachmentIcon,
  DeleteIcon,
  IssueIcon,
  PasteIcon,
  HeartbreakIcon,
  EdgelessIcon,
  JournalIcon,
  PaymentIcon,
  MemberIcon,
} from "@myoxus/icons/react";
import type { ComponentType, SVGProps } from "react";

import {
  isSupportedWorkspacePropertyType,
  WorkspacePropertyTypes,
} from "../../workspace-property-types";
import {
  type WorkspacePropertyIconName,
  WorkspacePropertyIconNames,
} from "./constant";

// Persisted property names keep a finite synchronous mapping; they never
// request the complete document-icon catalogue.
const propertyIcons = {
  ai: AiIcon,
  email: EmailIcon,
  text: TextIcon,
  dateTime: DateTimeIcon,
  keyboard: KeyboardIcon,
  pen: PenIcon,
  account: AccountIcon,
  embedWeb: EmbedWebIcon,
  layer: LayerIcon,
  pin: PinIcon,
  appearance: AppearanceIcon,
  eraser: EraserIcon,
  layout: LayoutIcon,
  presentation: PresentationIcon,
  bookmark: BookmarkIcon,
  exportToHtml: ExportToHtmlIcon,
  lightMode: LightModeIcon,
  progress: ProgressIcon,
  bulletedList: BulletedListIcon,
  exportToMarkdown: ExportToMarkdownIcon,
  link: LinkIcon,
  publish: PublishIcon,
  camera: CameraIcon,
  exportToPdf: ExportToPdfIcon,
  linkedEdgeless: LinkedEdgelessIcon,
  quote: QuoteIcon,
  checkBoxCheckLinear: CheckBoxCheckLinearIcon,
  exportToPng: ExportToPngIcon,
  linkedPage: LinkedPageIcon,
  save: SaveIcon,
  cloudWorkspace: CloudWorkspaceIcon,
  exportToSvg: ExportToSvgIcon,
  localData: LocalDataIcon,
  shape: ShapeIcon,
  code: CodeIcon,
  favorite: FavoriteIcon,
  localWorkspace: LocalWorkspaceIcon,
  style: StyleIcon,
  codeBlock: CodeBlockIcon,
  file: FileIcon,
  lock: LockIcon,
  tag: TagIcon,
  collaboration: CollaborationIcon,
  folder: FolderIcon,
  multiSelect: MultiSelectIcon,
  tags: TagsIcon,
  colorPicker: ColorPickerIcon,
  frame: FrameIcon,
  new: NewIcon,
  today: TodayIcon,
  contactWithUs: ContactWithUsIcon,
  grid: GridIcon,
  now: NowIcon,
  upgrade: UpgradeIcon,
  darkMode: DarkModeIcon,
  grouping: GroupingIcon,
  number: NumberIcon,
  userGuide: UserGuideIcon,
  databaseKanbanView: DatabaseKanbanViewIcon,
  image: ImageIcon,
  numberedList: NumberedListIcon,
  view: ViewIcon,
  databaseListView: DatabaseListViewIcon,
  inbox: InboxIcon,
  other: OtherIcon,
  viewLayers: ViewLayersIcon,
  databaseTableView: DatabaseTableViewIcon,
  info: InfoIcon,
  page: PageIcon,
  attachment: AttachmentIcon,
  delete: DeleteIcon,
  issue: IssueIcon,
  paste: PasteIcon,
  heartbreak: HeartbreakIcon,
  edgeless: EdgelessIcon,
  journal: JournalIcon,
  payment: PaymentIcon,
  member: MemberIcon,
} satisfies Record<
  WorkspacePropertyIconName,
  ComponentType<SVGProps<SVGSVGElement>>
>;

export const iconNameToComponent = (name: WorkspacePropertyIconName) => {
  const Icon = Object.hasOwn(propertyIcons, name)
    ? propertyIcons[name]
    : undefined;
  if (!Icon) throw new Error(`Icon ${name} not found`);
  return Icon;
};

export const WorkspacePropertyIcon = ({
  propertyInfo,
  ...props
}: {
  propertyInfo: DocCustomPropertyInfo;
} & SVGProps<SVGSVGElement>) => {
  const Icon =
    propertyInfo.icon &&
    WorkspacePropertyIconNames.includes(
      propertyInfo.icon as WorkspacePropertyIconName,
    )
      ? iconNameToComponent(propertyInfo.icon as WorkspacePropertyIconName)
      : isSupportedWorkspacePropertyType(propertyInfo.type)
        ? WorkspacePropertyTypes[propertyInfo.type].icon
        : WorkspacePropertyTypes.text.icon;

  return <Icon {...props} />;
};
