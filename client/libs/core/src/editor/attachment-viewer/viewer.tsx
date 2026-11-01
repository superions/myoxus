import { useI18n } from "@myoxus/i18n";
import { LocalDataIcon, MoreHorizontalIcon } from "@myoxus/icons/react";
import {
  AttachmentViewerMeta,
  AttachmentViewerTitle,
  AttachmentViewerTitlebar,
  AttachmentViewerTitlebarGroup,
  Group,
  HeaderMenuButton,
  IconButton,
  Menu,
  MenuItem,
  WorkbenchHeaderFrame,
} from "@myoxus/ui-facade";
import type { AttachmentBlockModel } from "@virgultum/editor/model";
import { useState } from "react";

import { download } from "./utils";

export const MenuItems = ({ model }: { model: AttachmentBlockModel }) => {
  const t = useI18n();
  return (
    <MenuItem
      onClick={() => {
        download(model).catch(console.error);
      }}
      prefixIcon={<LocalDataIcon />}
    >
      {t["com.myoxus.attachment.download"]()}
    </MenuItem>
  );
};

export interface TitlebarProps {
  model: AttachmentBlockModel;
  name: string;
  ext: string;
  size: string;
}

const DownloadAction = ({ model }: Pick<TitlebarProps, "model">) => {
  const t = useI18n();
  return (
    <IconButton
      icon={<LocalDataIcon />}
      aria-label={t["com.myoxus.attachment.download"]()}
      onClick={() => {
        download(model).catch(console.error);
      }}
    />
  );
};

const PeekTitlebarActions = ({ model }: Pick<TitlebarProps, "model">) => {
  const t = useI18n();
  const [openMenu, setOpenMenu] = useState(false);

  return (
    <>
      <DownloadAction model={model} />
      <Menu
        items={<MenuItems model={model} />}
        rootOptions={{
          open: openMenu,
          onOpenChange: setOpenMenu,
        }}
        contentOptions={{
          side: "bottom",
          align: "center",
          avoidCollisions: false,
        }}
      >
        <IconButton
          icon={<MoreHorizontalIcon />}
          aria-label={t["com.myoxus.common.open-menu"]()}
        />
      </Menu>
    </>
  );
};

const WorkbenchTitlebarActions = ({ model }: Pick<TitlebarProps, "model">) => {
  const t = useI18n();
  const [openMenu, setOpenMenu] = useState(false);

  return (
    <>
      <DownloadAction model={model} />
      <HeaderMenuButton
        ariaLabel={t["com.myoxus.common.open-menu"]()}
        items={<MenuItems model={model} />}
        open={openMenu}
        onOpenChange={setOpenMenu}
      />
    </>
  );
};

export const Titlebar = ({ model, name, ext, size }: TitlebarProps) => {
  return (
    <AttachmentViewerTitlebar>
      <AttachmentViewerTitlebarGroup>
        <AttachmentViewerTitle extension={ext} name={name} />
        <AttachmentViewerMeta>{size}</AttachmentViewerMeta>
        <PeekTitlebarActions model={model} />
      </AttachmentViewerTitlebarGroup>
    </AttachmentViewerTitlebar>
  );
};

export const AttachmentWorkbenchHeader = ({
  model,
  name,
  ext,
  size,
}: TitlebarProps) => {
  return (
    <WorkbenchHeaderFrame
      data-myoxus-ui-role="attachment-workbench-header-frame"
      title={<AttachmentViewerTitle extension={ext} name={name} />}
      right={
        <Group wrap="nowrap">
          <AttachmentViewerMeta>{size}</AttachmentViewerMeta>
          <WorkbenchTitlebarActions model={model} />
        </Group>
      }
    />
  );
};
