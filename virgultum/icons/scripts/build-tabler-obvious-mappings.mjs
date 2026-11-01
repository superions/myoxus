#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, "..");
const namesPath = path.join(packageDir, "src", "icon-names.json");
const reviewedPath = path.join(packageDir, "src/mappings/tabler-top-200.json");
const outputPath = path.join(packageDir, "src/mappings/tabler-obvious.json");
const checkMode = process.argv.includes("--check");

const iconNames = JSON.parse(fs.readFileSync(namesPath, "utf8"));
const reviewed = JSON.parse(fs.readFileSync(reviewedPath, "utf8"));
const reviewedNames = new Set(
  reviewed.icons.map(({ myoxus }) =>
    myoxus.endsWith("Icon") ? myoxus : `${myoxus}Icon`,
  ),
);
const tablerEntryPath = fileURLToPath(
  import.meta.resolve("@tabler/icons-react"),
);
const tablerPackageDir = path.resolve(path.dirname(tablerEntryPath), "../..");
const tablerDynamicImports = fs.readFileSync(
  path.join(tablerPackageDir, "dist/esm/dynamic-imports.mjs"),
  "utf8",
);
const tablerNames = new Set(
  [...tablerDynamicImports.matchAll(/icons\/(Icon[^'.]+)\.ts/g)].map(
    (match) => match[1],
  ),
);

const brandNames = new Set([
  "Apple",
  "Chrome",
  "Discord",
  "Facebook",
  "Figma",
  "Github",
  "Gitlab",
  "Google",
  "Instagram",
  "LinearLogo",
  "LoomLogo",
  "Notion",
  "ProductHunt",
  "Reddit",
  "Telegram",
  "Twitter",
  "Youtube",
  "Zendesk",
]);

// These are semantic aliases, not fuzzy guesses. Ambiguous and lossy candidates
// deliberately stay out of this table and are rendered on the local review page.
const safeAliases = {
  AccountBanIcon: "IconUserCancel",
  AccountEnableIcon: "IconUserCheck",
  AddCommentIcon: "IconMessageCirclePlus",
  AddCursorDuotoneIcon: "IconPointerPlus",
  AdminIcon: "IconUserShield",
  AiOutlineIcon: "IconSparkles",
  AlignBottomIcon: "IconLayoutAlignBottom",
  AlignHorizontalCenterIcon: "IconLayoutAlignCenter",
  AlignJustifyIcon: "IconAlignJustified",
  AlignTopIcon: "IconLayoutAlignTop",
  AlignVerticalCenterIcon: "IconLayoutAlignMiddle",
  AllDocsListViewIcon: "IconLayoutList",
  AllDocsMasonryViewIcon: "IconLayoutCollage",
  AppearanceIcon: "IconPalette",
  AppleIcon: "IconBrandApple",
  ArrowDownBigBottomIcon: "IconArrowBarToDown",
  ArrowUpBigTopIcon: "IconArrowBarToUp",
  AtSignIcon: "IconAt",
  AutoHeightIcon: "IconArrowAutofitHeight",
  AutoSizeIcon: "IconArrowAutofitContent",
  BackwardPanelIcon: "IconPlayerTrackPrev",
  BagPanelIcon: "IconShoppingBag",
  BarChart3Icon: "IconChartBar",
  BaseballPanelIcon: "IconBallBaseball",
  BasketballPanelIcon: "IconBallBasketball",
  BitcoinPanelIcon: "IconCurrencyBitcoin",
  BookTemplateIcon: "IconTemplate",
  BroomIcon: "IconClearAll",
  BubbleIcon: "IconMessage",
  CameraPanelIcon: "IconCamera",
  CancelWrapIcon: "IconTextWrapDisabled",
  CardPanelIcon: "IconCreditCard",
  Cart2PanelIcon: "IconShoppingCart",
  CartPanelIcon: "IconShoppingCart",
  ChartPanelIcon: "IconChartBar",
  ChatPanelIcon: "IconMessageCircle",
  CheckBoxIntermediateIcon: "IconSquareMinus",
  CheckCircleIcon: "IconCircleCheck",
  ChemicalPanelIcon: "IconFlask",
  CircleUserIcon: "IconUserCircle",
  Cloudy2PanelIcon: "IconCloud",
  CloudyPanelIcon: "IconCloud",
  CogIcon: "IconSettings",
  CollapseIcon: "IconArrowsMinimize",
  CollapseTabIcon: "IconLayoutSidebarLeftCollapse",
  ColorPanelIcon: "IconPalette",
  CommentDuodoneIcon: "IconMessageCircle",
  CompressIcon: "IconArrowsMinimize",
  Computer2PanelIcon: "IconDeviceDesktop",
  ComputerPanelIcon: "IconDeviceDesktop",
  ConfusePanelIcon: "IconMoodConfused",
  CollectPanelIcon: "IconStack",
  ContactWithUsIcon: "IconMessages",
  CrossedCircleIcon: "IconCircleX",
  CornerIcon: "IconCornerDownRight",
  CreatedIcon: "IconCalendarPlus",
  CurveLineIcon: "IconVectorSpline",
  CustomizedHeightIcon: "IconArrowsVertical",
  CustomSizeIcon: "IconResize",
  DarkModeIcon: "IconMoon",
  DashLineIcon: "IconLineDashed",
  Data2PanelIcon: "IconDatabase",
  DataPanelIcon: "IconDatabase",
  DeleteTemporarilyIcon: "IconTrash",
  Diagonally_2LinesIcon: "IconArrowsDiagonal2",
  DiscordDuotoneIcon: "IconBrandDiscord",
  DistributeHorizontalIcon: "IconLayoutDistributeHorizontal",
  DistributeVerticalIcon: "IconLayoutDistributeVertical",
  DocsDuotoneIcon: "IconFiles",
  DocsIcon: "IconFiles",
  DotDuotoneIcon: "IconPointFilled",
  DragCursorDuotoneIcon: "IconHandMove",
  DragCursorIcon: "IconHandMove",
  Drink2PanelIcon: "IconGlassFull",
  DrinkPanelIcon: "IconGlass",
  ElbowedLineIcon: "IconArrowElbowRight",
  EllipseIcon: "IconOval",
  EllipsisIcon: "IconDots",
  EmailIcon: "IconMail",
  EmailWarningIcon: "IconMailExclamation",
  EmbedWebIcon: "IconWorldCode",
  EndPointCircleIcon: "IconCircle",
  EndPointDiamondIcon: "IconSquareRotated",
  EndPointTriangleIcon: "IconTriangle",
  EnterIcon: "IconCornerDownLeft",
  EqIcon: "IconEqual",
  ExpandIcon: "IconArrowsMaximize",
  ExpandWideIcon: "IconArrowsHorizontal",
  ExperimentIcon: "IconFlask",
  ExportToMarkdownIcon: "IconMarkdown",
  ExportToPngIcon: "IconFileTypePng",
  ExportToSvgIcon: "IconFileTypeSvg",
  FacebookDuotoneIcon: "IconBrandFacebook",
  FigmaDuotoneIcon: "IconBrandFigma",
  FileClockIcon: "IconFileTime",
  FileIconAepIcon: "IconBrandAdobeAfterEffects",
  FileIconAiIcon: "IconFileAi",
  FileIconCssIcon: "IconFileTypeCss",
  FileIconCsvIcon: "IconFileTypeCsv",
  FileIconDocIcon: "IconFileTypeDoc",
  FileIconEpsIcon: "IconFileVector",
  FileIconFigIcon: "IconBrandFigma",
  FileIconInddIcon: "IconBrandAdobeIndesign",
  FileIconJpegIcon: "IconFileTypeJpg",
  FileIconJpgIcon: "IconFileTypeJpg",
  FileIconJsIcon: "IconFileTypeJs",
  FileIconPdfIcon: "IconFileTypePdf",
  FileIconPngIcon: "IconFileTypePng",
  FileIconPptIcon: "IconFileTypePpt",
  FileIconPptxIcon: "IconFileTypePpt",
  FileIconPsdIcon: "IconBrandAdobePhotoshop",
  FileIconRarIcon: "IconFileZip",
  FileIconRssIcon: "IconFileRss",
  FileIconSketchIcon: "IconBrandSketch",
  FileIconSqlIcon: "IconFileTypeSql",
  FileIconSvgIcon: "IconFileTypeSvg",
  FileIconTxtIcon: "IconFileTypeTxt",
  FileIconXlsIcon: "IconFileTypeXls",
  FileIconXlsxIcon: "IconFileTypeXls",
  FileIconXmlIcon: "IconFileTypeXml",
  FileSignatureIcon: "IconFileCertificate",
  FileWarningIcon: "IconFileAlert",
  FilteredIcon: "IconFilterCheck",
  FilterUndoIcon: "IconFilterOff",
  FirePanelIcon: "IconFlame",
  FlashPanelIcon: "IconBolt",
  FlipDirectionIcon: "IconSwitchHorizontal",
  Folder2PanelIcon: "IconFolder",
  Folder3PanelIcon: "IconFolder",
  FoodPanelIcon: "IconToolsKitchen2",
  ForwardPanelIcon: "IconPlayerTrackNext",
  ForwardThirtySecondsIcon: "IconRewindForward30",
  FullDayIcon: "IconCalendar",
  FruitPanelIcon: "IconApple",
  GamePanelIcon: "IconDeviceGamepad2",
  GeminiDuotoneIcon: "IconBrandGoogle",
  GithubDuotoneIcon: "IconBrandGithub",
  GitlabDuotoneIcon: "IconBrandGitlab",
  GobletPanelIcon: "IconGlass",
  GoogleDuotoneIcon: "IconBrandGoogle",
  GoogleMapDuotoneIcon: "IconBrandGoogleMaps",
  GoogleMapIcon: "IconBrandGoogleMaps",
  GptDuotoneIcon: "IconBrandOpenai",
  GoodIcon: "IconCheck",
  GridIcon: "IconLayoutGrid",
  GroupPanelIcon: "IconUsersGroup",
  GtIcon: "IconMathGreater",
  HamburgerPanelIcon: "IconBurger",
  HandIcon: "IconHandStop",
  HappyPanelIcon: "IconMoodHappy",
  HeaderColumnIcon: "IconTableColumn",
  HeaderRowIcon: "IconTableRow",
  HeadingsIcon: "IconHeading",
  HeadphonePanelIcon: "IconHeadphones",
  HeartbreakIcon: "IconHeartBroken",
  HelpCenterIcon: "IconHelpCircle",
  HidePanelIcon: "IconEyeOff",
  HighHeelPanelIcon: "IconShoe",
  HighLightDuotoneIcon: "IconHighlight",
  HighLightLinearIcon: "IconHighlight",
  ImagePanelIcon: "IconPhoto",
  InformationPanelIcon: "IconInfoCircle",
  InsertAboveIcon: "IconRowInsertTop",
  InsertBelowIcon: "IconRowInsertBottom",
  InsertBlocksIcon: "IconBlocks",
  InsertTopIcon: "IconRowInsertTop",
  InsyncIcon: "IconCloudCheck",
  InstagramDuotoneIcon: "IconBrandInstagram",
  JournalIcon: "IconNotebook",
  KeyRoundIcon: "IconKey",
  LayerIcon: "IconStack2",
  LayersIcon: "IconStack",
  LayoutTemplateIcon: "IconTemplate",
  LeftBracketIcon: "IconBrackets",
  LiftPanelIcon: "IconElevator",
  LightModeIcon: "IconSun",
  LightPanelIcon: "IconBulb",
  LineStyleIcon: "IconBorderStyle2",
  LinkBlockIcon: "IconLink",
  ListChecksIcon: "IconListCheck",
  Loader2Icon: "IconLoader2",
  LoadingIcon: "IconLoader2",
  LocalDataIcon: "IconDownload",
  LocateIcon: "IconCurrentLocation",
  LockKeyholeIcon: "IconLock",
  LogOutIcon: "IconLogout",
  LongSleevePanelIcon: "IconShirt",
  LoomLogoDuotoneIcon: "IconBrandLoom",
  LoomLogoIcon: "IconBrandLoom",
  LtIcon: "IconMathLower",
  McpIcon: "IconPlugConnected",
  MeetingIcon: "IconUsersGroup",
  MenubarIcon: "IconMenu2",
  MessageSquareTextIcon: "IconMessage",
  MicPanelIcon: "IconMicrophone",
  MindmapNodeIcon: "IconHierarchy3",
  MonitorIcon: "IconDeviceDesktop",
  MoonPanelIcon: "IconMoon",
  MountainPanelIcon: "IconMountain",
  MousePanelIcon: "IconMouse",
  MoveToIcon: "IconArrowsMove",
  MoveToLeftDuotoneIcon: "IconArrowBarToLeft",
  MoveToRightDuotoneIcon: "IconArrowBarToRight",
  MoviePanelIcon: "IconMovie",
  MultiCursorDuotoneIcon: "IconPointerCollaboration",
  MultiPeopleIcon: "IconUsersGroup",
  MultiSelectIcon: "IconListCheck",
  NeIcon: "IconArrowUpRight",
  NewIcon: "IconPlus",
  NewPageIcon: "IconFilePlus",
  NewXxxPageIcon: "IconFilePlus",
  NightPanelIcon: "IconMoon",
  NoNetworkIcon: "IconWifiOff",
  NotionDuotoneIcon: "IconBrandNotion",
  NumberIcon: "IconHash",
  OrganizationIcon: "IconBuilding",
  OtherIcon: "IconDots",
  PasteIcon: "IconClipboard",
  PauseCircleIcon: "IconPlayerPauseFilled",
  PauseIcon: "IconPlayerPause",
  PausePanelIcon: "IconPlayerPause",
  PeacePanelIcon: "IconPeace",
  PeriodIcon: "IconPointFilled",
  PersonPanelIcon: "IconUser",
  PickerPanelIcon: "IconColorPicker",
  PinedIcon: "IconPinnedFilled",
  PlayFillIcon: "IconPlayerPlayFilled",
  PlayIcon: "IconPlayerPlay",
  PlayPanelIcon: "IconPlayerPlay",
  PluginIcon: "IconPuzzle",
  PlusThickIcon: "IconPlus",
  PowerOffIcon: "IconPower",
  PptIcon: "IconFileTypePpt",
  Presentation2PanelIcon: "IconPresentation",
  ProductHuntDuotoneIcon: "IconBrandProducthunt",
  ProductHuntIcon: "IconBrandProducthunt",
  PropertyIcon: "IconAdjustmentsHorizontal",
  QrCodePanelIcon: "IconQrcode",
  RainPanelIcon: "IconCloudRain",
  RecentIcon: "IconHistory",
  RedditDuotoneIcon: "IconBrandReddit",
  RedoIcon: "IconArrowForwardUp",
  RemoveFolderIcon: "IconFolderMinus",
  RemoveIcon: "IconMinus",
  RewindFifteenSecondsIcon: "IconRewindBackward15",
  RightBracketIcon: "IconBrackets",
  RightSidebarIcon: "IconLayoutSidebarRight",
  RightTabIcon: "IconIndentIncrease",
  RotateAnticlockwiseIcon: "IconRotate2",
  RoundedRectangleIcon: "IconRectangleRoundedTop",
  RoundedSquareIcon: "IconSquareRounded",
  ScaleAltIcon: "IconResize",
  ScaleIcon: "IconResize",
  ScrollTextIcon: "IconFileText",
  SelectAreaIcon: "IconSelect",
  SelectIcon: "IconPointer",
  SelectTextIcon: "IconCursorText",
  SelfhostIcon: "IconServer",
  ShareiOsIcon: "IconUpload",
  ShieldAlertIcon: "IconShieldExclamation",
  ShapesIcon: "IconShape",
  SharedIcon: "IconUsers",
  SidebarDuotoneIcon: "IconLayoutSidebar",
  SignalIcon: "IconBrandSignal",
  SignalPanelIcon: "IconBrandSignal",
  SingleSelectCheckSolidIcon: "IconCircleCheckFilled",
  SingleSelectIcon: "IconCircle",
  SingleSelectSelectLinearIcon: "IconCircleCheck",
  SingleSelectUnIcon: "IconCircle",
  SkateboardPanelIcon: "IconSkateboard",
  ShoesPanelIcon: "IconShoe",
  SadPanelIcon: "IconMoodSad",
  SmileIcon: "IconMoodSmile",
  SmilePanelIcon: "IconMoodSmile",
  SmileSolidIcon: "IconMoodSmileFilled",
  Snow2PanelIcon: "IconSnowflake",
  SnowPanelIcon: "IconSnowflake",
  SocketPanelIcon: "IconPlugConnected",
  SortDownIcon: "IconSortDescending",
  SortUpIcon: "IconSortAscending",
  StartNumberingIcon: "IconListNumbers",
  StartPointArrowIcon: "IconArrowRight",
  StartPointCircleIcon: "IconCircle",
  StartPointDiamondIcon: "IconSquareRotated",
  StartPointIcon: "IconPointFilled",
  StartPointTriangleIcon: "IconTriangle",
  StopIcon: "IconPlayerStop",
  StraightLineIcon: "IconLine",
  StrikeThroughIcon: "IconStrikethrough",
  StyleIcon: "IconPalette",
  SucessfulDuotoneIcon: "IconCircleCheck",
  SucessfulIcon: "IconCircleCheck",
  SuitcasePanelIcon: "IconLuggage",
  SummarizeIcon: "IconFileDescription",
  SunPanelIcon: "IconSun",
  SunglassPanelIcon: "IconSunglasses",
  TagPanelIcon: "IconTag",
  TelegramDuotoneIcon: "IconBrandTelegram",
  TemplateColoredIcon: "IconTemplate",
  TemplateOutlineIcon: "IconTemplate",
  TeXDuotoneIcon: "IconTex",
  TextAlignBottomIcon: "IconLayoutAlignBottom",
  TextAlignMediumIcon: "IconLayoutAlignMiddle",
  TextAlignTopIcon: "IconLayoutAlignTop",
  TextBackgroundDuotoneIcon: "IconHighlight",
  TextTypeIcon: "IconLetterT",
  ThinkingIcon: "IconBrain",
  TimePanelIcon: "IconClock",
  TitleIcon: "IconHeading",
  ToggleUpIcon: "IconChevronUp",
  TranscriptWithAiIcon: "IconFileTextSpark",
  TriangleRulerPanelIcon: "IconRulerMeasure",
  TShirtPanelIcon: "IconShirt",
  TwitterDuotoneIcon: "IconBrandTwitter",
  TypeIcon: "IconLetterT",
  UnderLineIcon: "IconUnderline",
  UndoIcon: "IconArrowBackUp",
  UnlockIcon: "IconLockOpen",
  UnpinIcon: "IconPinnedOff",
  UnsucessfulDuotoneIcon: "IconCircleX",
  UnsucessfulIcon: "IconCircleX",
  UnsyncIcon: "IconCloudUpload",
  UpdatedIcon: "IconCalendarCheck",
  UpgradeIcon: "IconCircleArrowUp",
  UploadCloudIcon: "IconCloudUpload",
  UserGuideIcon: "IconBook2",
  UserRoundCheckIcon: "IconUserCheck",
  VoiceIcon: "IconMicrophone",
  VolumePanelIcon: "IconVolume",
  WaveRectangleIcon: "IconWaveSquare",
  WaypointsIcon: "IconRoute",
  WrapIcon: "IconTextWrap",
  YoutubeDuotoneIcon: "IconBrandYoutube",
  ZapIcon: "IconBolt",
  ZoomDownIcon: "IconZoomOut",
  ZoomUpIcon: "IconZoomIn",
};

function normalizedBase(iconName) {
  return iconName.slice(0, -"Icon".length);
}

function automaticMapping(iconName) {
  const base = normalizedBase(iconName);
  const exact = `Icon${base}`;
  if (tablerNames.has(exact)) return [exact, "same-name"];

  const variantBase = base.replace(
    /(Duotone|Linear|Outline|Colored|Panel)$/,
    "",
  );
  if (brandNames.has(variantBase)) {
    const brand = `IconBrand${variantBase.replace("Logo", "")}`.replace(
      "ProductHunt",
      "Producthunt",
    );
    if (tablerNames.has(brand)) return [brand, "brand-variant"];
  }
  if (variantBase !== base) {
    const variant = `Icon${variantBase}`;
    if (tablerNames.has(variant)) return [variant, "style-variant"];
  }

  const solidBase = base.replace(/(Solid|Fill)$/, "");
  if (solidBase !== base) {
    const filled = `Icon${solidBase}Filled`;
    if (tablerNames.has(filled)) return [filled, "filled-variant"];
  }

  const fileType = base.match(/^FileIcon(.+)$/)?.[1];
  if (fileType) {
    const target = `IconFileType${fileType}`;
    if (tablerNames.has(target)) return [target, "file-type"];
  }
  return null;
}

const failures = [];
const icons = [];
for (const myoxus of iconNames) {
  if (reviewedNames.has(myoxus)) continue;
  const alias = safeAliases[myoxus];
  const automatic = alias ? null : automaticMapping(myoxus);
  const tabler = alias ?? automatic?.[0];
  if (!tabler) continue;
  if (!tablerNames.has(tabler)) {
    failures.push(`${myoxus}: Tabler export ${tabler} does not exist`);
    continue;
  }
  icons.push({
    myoxus,
    tabler,
    classification: alias ? "semantic-alias" : automatic[1],
    status: "accepted",
  });
}

for (const myoxus of Object.keys(safeAliases)) {
  if (!iconNames.includes(myoxus))
    failures.push(`${myoxus}: not a public icon`);
  if (reviewedNames.has(myoxus)) failures.push(`${myoxus}: already reviewed`);
}
if (failures.length) {
  throw new Error(failures.map((failure) => `- ${failure}`).join("\n"));
}

const output = `${JSON.stringify(
  {
    schemaVersion: 1,
    decision: {
      iconSet: "tabler",
      package: "@tabler/icons-react",
      version: "3.45.0",
      license: "MIT",
    },
    scope: {
      publicIconCount: iconNames.length,
      previouslyReviewedGlyphCount: reviewedNames.size,
      acceptedObviousGlyphCount: icons.length,
      remainingAfterObviousCount:
        iconNames.length - reviewedNames.size - icons.length,
    },
    methodology: {
      description:
        "Namensgleiche Glyphen, rein technische Stil-/Panel-/Brandvarianten und explizit gepflegte semantisch eindeutige Aliase.",
      exclusion:
        "Produktglyphen, mehrdeutige Zustände/Richtungen und verlustbehaftete Dateityp-Zuordnungen bleiben zur manuellen Prüfung offen.",
    },
    icons,
  },
  null,
  2,
)}\n`;

if (checkMode) {
  const current = fs.existsSync(outputPath)
    ? fs.readFileSync(outputPath, "utf8")
    : null;
  if (current !== output) {
    throw new Error(
      "src/mappings/tabler-obvious.json is stale; run yarn workspace @virgultum/icons mapping:obvious",
    );
  }
} else {
  fs.writeFileSync(outputPath, output);
  console.log(
    `Wrote ${icons.length} obvious mappings; ${iconNames.length - reviewedNames.size - icons.length} remain after the obvious pass.`,
  );
}
