import {
  AiIcon,
  AllDocsIcon,
  AttachmentIcon,
  DeleteIcon,
  EdgelessIcon,
  ExportToPdfIcon,
  HomeIcon,
  InboxIcon,
  PageIcon,
  TagIcon,
  TodayIcon,
  ViewLayersIcon,
} from "@myoxus/icons/react";
import type { ReactNode } from "react";

export const iconNameToIcon = {
  allDocs: <AllDocsIcon />,
  collection: <ViewLayersIcon />,
  doc: <PageIcon />,
  page: <PageIcon />,
  edgeless: <EdgelessIcon />,
  journal: <TodayIcon />,
  tag: <TagIcon />,
  trash: <DeleteIcon />,
  attachment: <AttachmentIcon />,
  pdf: <ExportToPdfIcon />,
  ai: <AiIcon />,
  inbox: <InboxIcon />,
  home: <HomeIcon />,
} satisfies Record<string, ReactNode>;

export type ViewIconName = keyof typeof iconNameToIcon;
