// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  ActionIcon,
  Button as MantineButton,
  ColorSwatch,
  Divider,
  Group,
  Menu as MantineMenu,
  Paper,
  Popover,
  ScrollArea,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text as MantineText,
  TextInput,
} from "@mantine/core";
import { useI18n } from "@myoxus/i18n";
import { SearchIcon } from "@myoxus/icons/react";
import { cssVar } from "@myoxus/theme";
import {
  type HTMLAttributes,
  type ReactNode,
  startTransition,
  type SVGProps,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { joinClassName } from "./css-utils";
import {
  getIconCatalogSnapshot,
  getServerIconCatalogSnapshot,
  loadIconCatalog,
  subscribeIconCatalog,
  type IconCatalog,
} from "./helpers/icon-catalog";
import {
  loadEmojiGroups,
  loadIconKeywords,
  type EmojiGroup,
  type IconKeyword,
} from "./helpers/icon-picker-data";
import { type IconData, IconType } from "./helpers/icon-data";
import { IconRenderer } from "./helpers/icon-renderer";

const emojiGroupLabels: Record<
  string,
  (t: ReturnType<typeof useI18n>) => string
> = {
  Activity: (t) => t["com.myoxus.icon-picker.emoji-group.activity"](),
  "Animals & Nature": (t) =>
    t["com.myoxus.icon-picker.emoji-group.animals-nature"](),
  Flags: (t) => t["com.myoxus.icon-picker.emoji-group.flags"](),
  "Food & Drink": (t) => t["com.myoxus.icon-picker.emoji-group.food-drink"](),
  Objects: (t) => t["com.myoxus.icon-picker.emoji-group.objects"](),
  "Smileys & People": (t) =>
    t["com.myoxus.icon-picker.emoji-group.smileys-people"](),
  Symbols: (t) => t["com.myoxus.icon-picker.emoji-group.symbols"](),
  "Travel & Places": (t) =>
    t["com.myoxus.icon-picker.emoji-group.travel-places"](),
};

const colorList: string[] = [
  cssVar("textHighlightForegroundRed"),
  cssVar("textHighlightForegroundOrange"),
  cssVar("textHighlightForegroundYellow"),
  cssVar("textHighlightForegroundGreen"),
  cssVar("textHighlightForegroundTeal"),
  cssVar("textHighlightForegroundBlue"),
  cssVar("textHighlightForegroundPurple"),
  cssVar("textHighlightForegroundGrey"),
];

function readRecent(key: string) {
  if (typeof window === "undefined") return [];
  return window.localStorage.getItem(key)?.split(",").filter(Boolean) ?? [];
}

function writeRecent(key: string, values: string[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(key, values.join(","));
}

function translateEmojiGroupName(
  t: ReturnType<typeof useI18n>,
  groupName: string,
): string {
  return emojiGroupLabels[groupName]?.(t) ?? groupName;
}

function useRecentItems(key: string) {
  const [recent, setRecent] = useState<string[]>([]);

  useEffect(() => setRecent(readRecent(key)), [key]);

  const add = useCallback(
    (value: string) => {
      setRecent((prev) => {
        const next = [value, ...prev.filter((item) => item !== value)].slice(
          0,
          10,
        );
        writeRecent(key, next);
        return next;
      });
    },
    [key],
  );

  return { recent, add };
}

function MyoxusIconRenderer({
  catalog,
  color,
  name,
  ...props
}: {
  catalog: IconCatalog;
  name: string;
  color?: string;
} & SVGProps<SVGSVGElement>) {
  const Icon = catalog[`${name}Icon` as keyof typeof catalog] as
    React.ComponentType<SVGProps<SVGSVGElement>> | undefined;
  if (!Icon) return null;
  return <Icon {...props} color={color} />;
}

function PickerIconButton({
  children,
  label,
  onClick,
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <ActionIcon
      aria-label={label}
      variant="subtle"
      size={"calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm))"}
      onClick={onClick}
    >
      {children}
    </ActionIcon>
  );
}

function IconPickerPanel({
  children,
  tools,
}: {
  children: ReactNode;
  tools: ReactNode;
}) {
  return (
    <Stack component="section" flex={1} gap="xs" mih={0}>
      <Group align="center" gap="sm" px="md" pt="md">
        {tools}
      </Group>
      <ScrollArea flex={1} px="md" pb="sm" type="auto">
        <Stack gap="sm">{children}</Stack>
      </ScrollArea>
    </Stack>
  );
}

function IconPickerGroup({
  children,
  label,
}: {
  children: ReactNode;
  label: ReactNode;
}) {
  return (
    <Stack gap="xs">
      <MantineText c="dimmed" fw={500} px="xs" size="xs">
        {label}
      </MantineText>
      <SimpleGrid cols={7} spacing="xs" verticalSpacing="xs">
        {children}
      </SimpleGrid>
    </Stack>
  );
}

function EmojiPicker({ onSelect }: { onSelect?: (emoji: string) => void }) {
  const t = useI18n();
  const [keyword, setKeyword] = useState("");
  const [emojiGroups, setEmojiGroups] = useState<EmojiGroup[]>();
  const [loadError, setLoadError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [filteredGroups, setFilteredGroups] = useState<EmojiGroup[]>([]);
  const { recent, add } = useRecentItems("recentEmojis");

  useEffect(() => {
    // A shared import may finish after close or a panel switch; only this mount
    // owns its visible state. Search and selection remain independent of loading.
    let active = true;
    setLoadError(false);
    void loadEmojiGroups()
      .then((groups) => {
        if (active) setEmojiGroups(groups);
      })
      .catch(() => {
        if (active) setLoadError(true);
      });
    return () => {
      active = false;
    };
  }, [attempt]);

  useEffect(() => {
    startTransition(() => {
      const term = keyword.trim().toLowerCase();
      if (!term) {
        setFilteredGroups(emojiGroups ?? []);
        return;
      }
      setFilteredGroups(
        (emojiGroups ?? [])
          .map((group) => ({
            ...group,
            emojis: group.emojis.filter((emoji) => {
              const haystack = [
                emoji.label,
                emoji.annotation,
                ...(emoji.shortcodes ?? []),
                ...(emoji.tags ?? []),
              ]
                .filter(Boolean)
                .join(" ")
                .toLowerCase();
              return haystack.includes(term);
            }),
          }))
          .filter((group) => group.emojis.length > 0),
      );
    });
  }, [keyword, emojiGroups]);

  const handleSelect = useCallback(
    (emoji: string) => {
      add(emoji);
      onSelect?.(emoji);
    },
    [add, onSelect],
  );

  const recentGroup = useMemo<EmojiGroup | null>(
    () =>
      recent.length
        ? {
            name: t.t("com.myoxus.icon-picker.recent"),
            emojis: recent.map((emoji) => ({
              label: emoji,
              hexcode: "",
              unicode: emoji,
            })),
          }
        : null,
    [recent, t],
  );

  return (
    <IconPickerPanel
      tools={
        <TextInput
          flex={1}
          value={keyword}
          onChange={(event) => setKeyword(event.currentTarget.value)}
          placeholder={t.t("com.myoxus.icon-picker.filter-placeholder")}
          leftSection={<SearchIcon />}
          size="sm"
        />
      }
    >
      {loadError ? (
        <>
          <MantineText role="alert">
            {t["com.myoxus.icon-picker.error.load-data"]()}
          </MantineText>
          <MantineButton onClick={() => setAttempt((value) => value + 1)}>
            {t["Retry"]()}
          </MantineButton>
        </>
      ) : !emojiGroups ? (
        <MantineText role="status">{t["Loading"]()}</MantineText>
      ) : null}
      {[...(recentGroup ? [recentGroup] : []), ...filteredGroups].map(
        (group) => {
          const groupLabel = translateEmojiGroupName(t, group.name);
          return (
            <IconPickerGroup key={group.name} label={groupLabel}>
              {group.emojis.map((emoji) => (
                <PickerIconButton
                  key={`${group.name}:${emoji.label}:${emoji.unicode}`}
                  label={emoji.label}
                  onClick={() => handleSelect(emoji.unicode)}
                >
                  <MantineText
                    component="span"
                    fz={"var(--mantine-spacing-xl)"}
                    lh={1}
                  >
                    {emoji.unicode}
                  </MantineText>
                </PickerIconButton>
              ))}
            </IconPickerGroup>
          );
        },
      )}
    </IconPickerPanel>
  );
}

function MyoxusIconPicker({
  onSelect,
}: {
  onSelect?: (icon: string, color: string) => void;
}) {
  const t = useI18n();
  const searchRef = useRef<HTMLInputElement>(null);
  const snapshot = useSyncExternalStore(
    subscribeIconCatalog,
    getIconCatalogSnapshot,
    getServerIconCatalogSnapshot,
  );
  useEffect(() => {
    if (snapshot.status === "idle") loadIconCatalog();
  }, [snapshot.status]);
  const catalog = snapshot.status === "ready" ? snapshot.catalog : undefined;
  const [keyword, setKeyword] = useState("");
  const [keywords, setKeywords] = useState<IconKeyword[]>();
  const [loadError, setLoadError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [color, setColor] = useState<string>(
    cssVar("textHighlightForegroundBlue"),
  );
  const { recent, add } = useRecentItems("recentIcons");
  useEffect(() => {
    let active = true;
    setLoadError(false);
    void loadIconKeywords()
      .then((data) => {
        if (active) setKeywords(data);
      })
      .catch(() => {
        if (active) setLoadError(true);
      });
    return () => {
      active = false;
    };
  }, [attempt]);
  const filteredIcons = useMemo(() => {
    const myoxusIcons = (keywords ?? []).filter(
      (icon) => catalog && `${icon.name}Icon` in catalog,
    );
    const term = keyword.trim().toLowerCase();
    if (!term) return myoxusIcons;
    return myoxusIcons.filter((icon) =>
      [icon.name, ...icon.keywords].join(" ").toLowerCase().includes(term),
    );
  }, [keyword, keywords, catalog]);

  const handleSelect = useCallback(
    (iconName: string) => {
      add(iconName);
      onSelect?.(iconName, color);
    },
    [add, color, onSelect],
  );

  const renderIcon = (iconName: string) => (
    <PickerIconButton
      key={iconName}
      label={iconName}
      onClick={() => handleSelect(iconName)}
    >
      {catalog ? (
        <MyoxusIconRenderer
          catalog={catalog}
          name={iconName}
          color={color}
          height={"var(--mantine-spacing-xl)"}
          width={"var(--mantine-spacing-xl)"}
        />
      ) : null}
    </PickerIconButton>
  );

  return (
    <IconPickerPanel
      tools={
        <>
          <TextInput
            ref={searchRef}
            flex={1}
            value={keyword}
            onChange={(event) => setKeyword(event.currentTarget.value)}
            placeholder={t.t("com.myoxus.icon-picker.filter-placeholder")}
            leftSection={<SearchIcon />}
            size="sm"
          />
          {/* Keep palette clicks inside the owning picker/bridge popup so its
            outside-click handler cannot dismiss the pending selection. */}
          <MantineMenu position="bottom-end" shadow="md" withinPortal={false}>
            <MantineMenu.Target>
              <ActionIcon
                aria-label={t.t("com.myoxus.icon-picker.icon-color")}
                variant="subtle"
                size="lg"
              >
                <ColorSwatch color={color} size="1em" />
              </ActionIcon>
            </MantineMenu.Target>
            <MantineMenu.Dropdown>
              <Group gap="xs" p="xs">
                {colorList.map((nextColor) => (
                  <ActionIcon
                    key={nextColor}
                    aria-label={nextColor}
                    variant="subtle"
                    size="md"
                    onClick={() => setColor(nextColor)}
                  >
                    <ColorSwatch color={nextColor} size="1em" />
                  </ActionIcon>
                ))}
              </Group>
            </MantineMenu.Dropdown>
          </MantineMenu>
        </>
      }
    >
      {loadError || snapshot.status === "error" ? (
        <>
          <MantineText role="alert">
            {t["com.myoxus.icon-picker.error.load-data"]()}
          </MantineText>
          <MantineButton
            onClick={() => {
              if (snapshot.status === "error") loadIconCatalog();
              if (loadError) setAttempt((value) => value + 1);
              // Retry can remove its focused button. Keep keyboard handling
              // inside the still-mounted picker instead of falling to body.
              searchRef.current?.focus();
            }}
          >
            {t["Retry"]()}
          </MantineButton>
        </>
      ) : !keywords || !catalog ? (
        <MantineText role="status">{t["Loading"]()}</MantineText>
      ) : null}
      {catalog && recent.length ? (
        <IconPickerGroup label={t.t("com.myoxus.icon-picker.recent")}>
          {recent.map(renderIcon)}
        </IconPickerGroup>
      ) : null}
      <IconPickerGroup label={t.t("com.myoxus.icon-picker.icons")}>
        {filteredIcons.map((icon) => renderIcon(icon.name))}
      </IconPickerGroup>
    </IconPickerPanel>
  );
}

export const IconPicker = ({
  className,
  style,
  onSelect,
}: Omit<HTMLAttributes<HTMLDivElement>, "onSelect"> & {
  onSelect?: (data?: IconData) => void;
}) => {
  const t = useI18n();
  const [activePanel, setActivePanel] = useState("emoji");

  return (
    <Paper
      bg={cssVar("backgroundOverlayPanelColor")}
      c={cssVar("textPrimaryColor")}
      className={joinClassName("myoxus-icon-picker", className)}
      h={"400px"}
      maw="100%"
      style={style}
      w={"400px"}
    >
      <Stack gap={0} h="100%">
        <Stack gap="sm" px="md" pt="md">
          <Group align="center" gap="sm" justify="space-between">
            <SegmentedControl
              size="sm"
              value={activePanel}
              onChange={setActivePanel}
              data={[
                { label: t.t("com.myoxus.icon-picker.emoji"), value: "emoji" },
                { label: t.t("com.myoxus.icon-picker.icons"), value: "icons" },
              ]}
            />
            <MantineButton
              variant="subtle"
              size="sm"
              onClick={() => onSelect?.()}
            >
              {t.t("com.myoxus.common.remove")}
            </MantineButton>
          </Group>
          <Divider />
        </Stack>
        <Stack component="main" flex={1} gap={0} mih={0}>
          {activePanel === "emoji" ? (
            <EmojiPicker
              onSelect={(emoji) =>
                onSelect?.({ type: IconType.Emoji, unicode: emoji })
              }
            />
          ) : (
            <MyoxusIconPicker
              onSelect={(name, color) =>
                onSelect?.({ type: IconType.MyoxusIcon, name, color })
              }
            />
          )}
        </Stack>
      </Stack>
    </Paper>
  );
};

export interface IconEditorProps {
  icon?: IconData;
  closeAfterSelect?: boolean;
  iconPlaceholder?: ReactNode;
  onIconChange?: (data?: IconData) => void;
  triggerClassName?: string;
  triggerVariant?: IconEditorTriggerVariant;
}

export type IconEditorTriggerVariant =
  "default" | "document-title" | "document-title-placeholder";

const iconEditorTriggerVariantClassName: Record<
  IconEditorTriggerVariant,
  string | undefined
> = {
  default: undefined,
  "document-title": "myoxus-icon-name-editor__trigger--document-title",
  "document-title-placeholder":
    "myoxus-icon-name-editor__trigger--document-title myoxus-icon-name-editor__trigger--document-title-placeholder",
};

function getIconEditorTriggerClassName(
  variant: IconEditorTriggerVariant = "default",
  className?: string,
) {
  return joinClassName(
    "myoxus-icon-name-editor__trigger",
    iconEditorTriggerVariantClassName[variant],
    className,
  );
}

function getIconEditorTriggerVisualProps(
  variant: IconEditorTriggerVariant = "default",
) {
  const isDocumentTitle = variant === "document-title";
  const isDocumentTitlePlaceholder = variant === "document-title-placeholder";
  const isDocumentTitleVariant = isDocumentTitle || isDocumentTitlePlaceholder;

  return {
    iconSize: isDocumentTitleVariant
      ? `calc(calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm)) - calc(var(--mantine-spacing-2xs) + var(--mantine-spacing-xs)))`
      : "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
    radius: isDocumentTitleVariant ? "xl" : "sm",
    size: isDocumentTitleVariant
      ? "calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm))"
      : "md",
    variant: isDocumentTitlePlaceholder
      ? "light"
      : isDocumentTitle
        ? "subtle"
        : "default",
  } as const;
}

export function IconEditorTriggerFrame({
  children,
  className,
  iconType,
  variant = "default",
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  iconType?: string;
  variant?: IconEditorTriggerVariant;
}) {
  const triggerVisualProps = getIconEditorTriggerVisualProps(variant);

  return (
    <ActionIcon
      {...props}
      className={getIconEditorTriggerClassName(variant, className)}
      component="span"
      data-icon-type={iconType}
      data-myoxus-ui-role="icon-editor-trigger-frame"
      radius={triggerVisualProps.radius}
      size={triggerVisualProps.size}
      variant={triggerVisualProps.variant}
    >
      {children}
    </ActionIcon>
  );
}

export function DocumentIconTitleSlot({
  children,
  className,
  hasIcon,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  hasIcon: boolean;
}) {
  return (
    <div
      {...props}
      // The Lit doc-title fragment is outside React; this stable class is the
      // shared layout bridge between the facade trigger and editor title grid.
      className={joinClassName("doc-icon-container", className)}
      data-has-icon={hasIcon ? "true" : "false"}
      data-myoxus-ui-role="document-icon-title-slot"
    >
      {children}
    </div>
  );
}

export function IconEditorPlaceholder({
  children,
  className,
  icon,
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  icon?: ReactNode;
}) {
  return (
    <Group
      {...props}
      align="center"
      className={joinClassName("myoxus-icon-editor-placeholder", className)}
      component="span"
      gap="xs"
      data-myoxus-ui-role="icon-editor-placeholder"
    >
      {icon ? (
        <MantineText c="dimmed" component="span" size="sm">
          {icon}
        </MantineText>
      ) : null}
      <MantineText c="dimmed" component="span" size="sm">
        {children}
      </MantineText>
    </Group>
  );
}

export interface IconAndNameEditorContentProps extends IconEditorProps {
  name: string;
  namePlaceholder?: string;
  onNameChange?: (name: string) => void;
  onEnter?: () => void;
  inputTestId?: string;
}

export interface IconAndNameEditorMenuProps extends IconAndNameEditorContentProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  width?: string | number;
  skipIfNotChanged?: boolean;
  children?: ReactNode;
  contentOptions?: {
    sideOffset?: number;
    className?: string;
    style?: React.CSSProperties;
  };
  rootOptions?: {
    modal?: boolean;
  };
}

export const IconEditor = ({
  icon,
  closeAfterSelect,
  iconPlaceholder,
  triggerClassName,
  triggerVariant = "default",
  onIconChange,
}: IconEditorProps & {
  alignOffset?: number;
  sideOffset?: number;
}) => {
  const t = useI18n();
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const pickerLabel = icon
    ? t.t("com.myoxus.icon-picker.change-icon")
    : t.t("com.myoxus.icon-picker.select-icon");
  const triggerVisualProps = getIconEditorTriggerVisualProps(triggerVariant);

  const handleSelect = useCallback(
    (data?: IconData) => {
      onIconChange?.(data);
      if (closeAfterSelect) setIsPickerOpen(false);
    },
    [closeAfterSelect, onIconChange],
  );

  return (
    <Popover
      opened={isPickerOpen}
      onChange={setIsPickerOpen}
      position="bottom-start"
      shadow="md"
    >
      <Popover.Target>
        <ActionIcon
          className={getIconEditorTriggerClassName(
            triggerVariant,
            triggerClassName,
          )}
          data-icon-type={icon?.type}
          aria-label={pickerLabel}
          title={pickerLabel}
          onClick={() => setIsPickerOpen((open) => !open)}
          radius={triggerVisualProps.radius}
          size={triggerVisualProps.size}
          type="button"
          variant={triggerVisualProps.variant}
        >
          <IconRenderer
            data={icon}
            fallback={iconPlaceholder}
            size={triggerVisualProps.iconSize}
          />
        </ActionIcon>
      </Popover.Target>
      <Popover.Dropdown p={0}>
        <div onWheel={(event) => event.stopPropagation()}>
          <IconPicker onSelect={handleSelect} />
        </div>
      </Popover.Dropdown>
    </Popover>
  );
};

export const IconAndNameEditorContent = ({
  name,
  namePlaceholder,
  inputTestId,
  onNameChange,
  onEnter,
  ...iconEditorProps
}: IconAndNameEditorContentProps) => {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.select();
  }, []);

  return (
    <Group align="center" gap="sm" p="xs">
      <IconEditor {...iconEditorProps} />
      <TextInput
        ref={inputRef}
        placeholder={namePlaceholder}
        value={name}
        onChange={(event) => onNameChange?.(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") onEnter?.();
        }}
        flex={1}
        autoFocus
        data-testid={inputTestId}
        size="xs"
      />
    </Group>
  );
};

export const IconAndNameEditorMenu = ({
  open,
  onOpenChange,
  width = 300,
  icon: initialIcon,
  name: initialName,
  onIconChange,
  onNameChange,
  contentOptions,
  iconPlaceholder,
  skipIfNotChanged = true,
  inputTestId,
  closeAfterSelect,
  children,
}: IconAndNameEditorMenuProps) => {
  const [icon, setIcon] = useState(initialIcon);
  const [name, setName] = useState(initialName);

  const commit = useCallback(() => {
    if (icon !== initialIcon) onIconChange?.(icon);
    if (!skipIfNotChanged || name !== initialName) onNameChange?.(name);
  }, [
    icon,
    initialIcon,
    initialName,
    name,
    onIconChange,
    onNameChange,
    skipIfNotChanged,
  ]);

  const abort = useCallback(() => {
    setIcon(initialIcon);
    setName(initialName);
  }, [initialIcon, initialName]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        setIcon(initialIcon);
        setName(initialName);
      } else if (open) {
        commit();
      }
      onOpenChange?.(nextOpen);
    },
    [commit, initialIcon, initialName, onOpenChange, open],
  );

  return (
    <Popover
      opened={open}
      onChange={handleOpenChange}
      position="bottom-start"
      offset={contentOptions?.sideOffset ?? 4}
      shadow="md"
    >
      <Popover.Target>{children as React.ReactElement}</Popover.Target>
      <Popover.Dropdown
        className={contentOptions?.className}
        style={{ width, ...contentOptions?.style }}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            abort();
            onOpenChange?.(false);
          }
        }}
      >
        <IconAndNameEditorContent
          icon={icon}
          name={name}
          iconPlaceholder={iconPlaceholder}
          closeAfterSelect={closeAfterSelect}
          onIconChange={setIcon}
          onNameChange={setName}
          inputTestId={inputTestId}
          onEnter={() => {
            commit();
            onOpenChange?.(false);
          }}
        />
      </Popover.Dropdown>
    </Popover>
  );
};
