import { TagService } from "@myoxus/core/modules/tag";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Collapse,
  ColorSwatch,
  Group,
  IconButton,
  type MenuSubProps,
  type TagColorRole,
  useMobileMenuController,
} from "@myoxus/ui-facade";
import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

import { useWorkspaceTagColorOptions } from "../../../../../components/tags";
import { RenameContent, RenameSubMenu } from "../../../rename";
import { RenameDialog } from "../../../rename/dialog";
import type { RenameContentProps } from "../../../rename/type";

type TagColorContextValue = {
  colors: ReadonlyArray<{ name: string; value: TagColorRole }>;
  color: TagColorRole;
  setColor: Dispatch<SetStateAction<TagColorRole>>;
  show: boolean;
  setShow: Dispatch<SetStateAction<boolean>>;
  enableAnimation?: boolean;
};

const TagColorContext = createContext<TagColorContextValue | null>(null);

function useTagColorContext() {
  const value = useContext(TagColorContext);
  if (!value) {
    throw new Error("Tag color controls require TagColorContext");
  }
  return value;
}

const ColorPickerTrigger = () => {
  const { color, show, setShow } = useTagColorContext();
  const t = useI18n();
  return (
    <IconButton
      aria-expanded={show}
      aria-label={t["Colors"]()}
      data-testid="tag-color-picker-trigger"
      data-active={show ? "true" : undefined}
      data-myoxus-ui-role="mobile-tag-color-picker-trigger"
      onClick={() => setShow((prev) => !prev)}
      variant={show ? "primary" : "plain"}
    >
      <ColorSwatch tagColorRole={color} shape="circle" />
    </IconButton>
  );
};

const ColorPickerSelect = () => {
  const {
    enableAnimation,
    colors,
    color: current,
    setColor,
    show,
  } = useTagColorContext();

  if (!show && !enableAnimation) return null;

  return (
    <Collapse expanded={show} keepMounted={enableAnimation}>
      <Group
        justify="space-between"
        wrap="nowrap"
        data-testid="tag-color-picker-select"
        data-myoxus-ui-role="mobile-tag-color-picker-select"
      >
        {colors.map(({ name, value: color }) => (
          <IconButton
            key={color}
            aria-pressed={color === current}
            aria-label={name}
            data-color={color}
            data-myoxus-ui-role="mobile-tag-color-picker-option"
            onClick={() => setColor(color)}
            variant={color === current ? "primary" : "plain"}
          >
            <ColorSwatch tagColorRole={color} shape="circle" />
          </IconButton>
        ))}
      </Group>
    </Collapse>
  );
};

interface TagRenameContentProps extends Omit<RenameContentProps, "onConfirm"> {
  initialColor?: TagColorRole;
  onConfirm?: (name: string, color: TagColorRole) => void;
  enableAnimation?: boolean;
}
const TagRenameContent = ({
  initialColor,
  onConfirm,
  enableAnimation,
  ...props
}: TagRenameContentProps) => {
  const tagService = useService(TagService);
  const colors = useWorkspaceTagColorOptions();

  const [color, setColor] = useState(
    initialColor || tagService.randomTagColor(),
  );
  const [show, setShow] = useState(false);

  const handleConfirm = useCallback(
    (name: string) => {
      onConfirm?.(name, color);
    },
    [color, onConfirm],
  );
  const tagColorContextValue = useMemo(
    () => ({ colors, color, setColor, show, setShow, enableAnimation }),
    [color, colors, enableAnimation, show],
  );

  return (
    <TagColorContext.Provider value={tagColorContextValue}>
      <RenameContent
        inputPrefixRenderer={ColorPickerTrigger}
        inputBelowRenderer={ColorPickerSelect}
        onConfirm={handleConfirm}
        {...props}
      />
    </TagColorContext.Provider>
  );
};

interface TagRenameDialogProps extends TagRenameContentProps {
  title?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}
export const TagRenameDialog = ({
  title: propsTitle,
  confirmText: propsConfirmText,
  open,
  onOpenChange,
  ...props
}: TagRenameDialogProps) => {
  const t = useI18n();
  const title = propsTitle || t["com.myoxus.m.explorer.tag.new-dialog-title"]();
  const confirmText =
    propsConfirmText || t["com.myoxus.m.explorer.tag.rename-confirm"]();

  return (
    <RenameDialog
      open={open}
      onOpenChange={onOpenChange}
      inputPrefixRenderer={ColorPickerTrigger}
      title={title}
      confirmText={confirmText}
    >
      <TagRenameContent {...props} />
    </RenameDialog>
  );
};

interface TagRenameSubMenuProps {
  tagId?: string;
  title?: string;
  icon?: ReactNode;
  text?: string;
  onConfirm?: (name: string, color: TagColorRole) => void;
  menuProps?: Partial<MenuSubProps>;
}
export const TagRenameSubMenu = ({
  tagId,
  title,
  icon,
  text,
  menuProps,
  onConfirm,
}: TagRenameSubMenuProps) => {
  const t = useI18n();
  const { close } = useMobileMenuController();
  const tagService = useService(TagService);
  const tagRecord = useLiveData(tagService.tagList.tagByTagId$(tagId));
  const tagName = useLiveData(tagRecord?.value$);
  const tagColor = useLiveData(tagRecord?.color$);

  const handleCloseAndConfirm = useCallback(
    (name: string, color: TagColorRole) => {
      close();
      onConfirm?.(name, color);
    },
    [close, onConfirm],
  );

  return (
    <RenameSubMenu
      title={title ?? t["com.myoxus.m.explorer.tag.rename-menu-title"]()}
      icon={icon}
      text={text}
      menuProps={menuProps}
    >
      <TagRenameContent
        initialName={tagName}
        initialColor={tagColor}
        onConfirm={handleCloseAndConfirm}
      />
    </RenameSubMenu>
  );
};
