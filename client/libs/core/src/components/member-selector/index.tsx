import {
  type Member,
  MemberSearchService,
} from "@myoxus/core/modules/permissions";
import { DoneIcon } from "@myoxus/icons/react";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Avatar,
  BadgeList,
  BadgeListItem,
  Menu,
  MenuItem,
  MenuPanel,
  type MenuRef,
  MenuScrollableSection,
  MenuSection,
  MenuSeparator,
  MyoxusText,
  RowInput,
} from "@myoxus/ui-facade";
import { clamp, debounce } from "lodash-es";
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

import { ConfigModal } from "../mobile";
import { InlineMemberList } from "./inline-member-list";

export interface MemberSelectorProps {
  selected: string[];
  /** Single mode replaces the selection only after an explicit member pick. */
  selectionMode?: "single" | "multiple";
  style?: React.CSSProperties;
  className?: string;
  onChange: (selected: string[]) => void;
}

export interface MemberSelectorInlineProps extends MemberSelectorProps {
  modalMenu?: boolean;
  menuClassName?: string;
  readonly?: boolean;
  title?: ReactNode; // only used for mobile
  placeholder?: ReactNode;
  ref?: React.Ref<MenuRef>;
  onEditorClose?: () => void;
}

interface MemberSelectItemProps {
  member: Member;
}

const MemberSelectItem = ({ member }: MemberSelectItemProps) => {
  return member.name;
};

interface MemberSelectorInlineSurfaceProps extends Omit<
  React.HTMLAttributes<HTMLUListElement>,
  "placeholder" | "onChange"
> {
  empty: boolean;
  ref?: React.Ref<HTMLUListElement>;
  placeholder?: ReactNode;
  readonly?: boolean;
  selected: string[];
  style?: React.CSSProperties;
}

const MemberSelectorInlineSurface = ({
  className,
  empty,
  onClick,
  placeholder,
  readonly,
  selected,
  style,
  ...triggerProps
}: MemberSelectorInlineSurfaceProps) => {
  // Menu.Target injects focus, keyboard, ARIA and anchor-ref attributes. They
  // must reach the same native list in both empty and populated states.
  const sharedProps = {
    ...triggerProps,
    "aria-disabled": readonly ? true : undefined,
    className,
    "data-empty": empty ? "true" : undefined,
    "data-readonly": readonly ? "true" : undefined,
    onClick,
    style,
  };

  if (!empty) {
    return <InlineMemberList members={selected} {...sharedProps} />;
  }

  return (
    <BadgeList {...sharedProps}>
      <BadgeListItem grow>
        <MyoxusText
          component="span"
          tone="secondary"
          typographySlot="body-small"
        >
          {placeholder}
        </MyoxusText>
      </BadgeListItem>
    </BadgeList>
  );
};

export const MemberSelector = ({
  selected,
  className,
  onChange,
  style,
  selectionMode = "multiple",
  onSelectionComplete,
}: MemberSelectorProps & { onSelectionComplete?: () => void }) => {
  const t = useI18n();
  const [inputValue, setInputValue] = useState("");
  const memberSearchService = useService(MemberSearchService);

  const searchedMembers = useLiveData(memberSearchService.result$);

  useEffect(() => {
    // reset the search text when the component is mounted
    memberSearchService.reset();
    memberSearchService.loadMore();
  }, [memberSearchService]);

  const debouncedSearch = useMemo(
    () => debounce((value: string) => memberSearchService.search(value), 300),
    [memberSearchService],
  );

  const inputRef = useRef<HTMLInputElement>(null);

  const [focusedIndex, setFocusedIndex] = useState<number>(-1);
  const [focusedInlineIndex, setFocusedInlineIndex] = useState<number>(-1);

  // -1: no focus
  const safeFocusedIndex = clamp(focusedIndex, -1, searchedMembers.length - 1);
  // inline tags focus index can go beyond the length of tagIds
  // using -1 and tagIds.length to make keyboard navigation easier
  const safeInlineFocusedIndex = clamp(focusedInlineIndex, -1, selected.length);

  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const onInputChange = useCallback(
    (value: string) => {
      setInputValue(value);
      if (value.length > 0) {
        setFocusedInlineIndex(selected.length);
      }
      debouncedSearch(value.trim());
    },
    [debouncedSearch, selected.length],
  );

  const onToggleMember = useCallback(
    (id: string) => {
      if (!selected.includes(id)) {
        onChange(selectionMode === "single" ? [id] : [...selected, id]);
      } else {
        onChange(selected.filter((itemId) => itemId !== id));
      }
    },
    [selected, onChange, selectionMode],
  );

  const focusInput = useCallback(() => {
    inputRef.current?.focus();
  }, []);

  const onSelectTagOption = useCallback(
    (member: Member) => {
      onToggleMember(member.id);
      setInputValue("");
      focusInput();
      setFocusedIndex(-1);
      setFocusedInlineIndex(selected.length + 1);
      if (selectionMode === "single") onSelectionComplete?.();
    },
    [
      onToggleMember,
      focusInput,
      selected.length,
      selectionMode,
      onSelectionComplete,
    ],
  );
  const onEnter = useCallback(() => {
    if (safeFocusedIndex >= 0) {
      onSelectTagOption(searchedMembers[safeFocusedIndex]);
    }
  }, [onSelectTagOption, safeFocusedIndex, searchedMembers]);

  const handleUnselectMember = useCallback(
    (id: string) => {
      onToggleMember(id);
      focusInput();
    },
    [onToggleMember, focusInput],
  );

  const onInputKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        // RowInput.onEnter selects the member; do not also submit its owning form.
        e.preventDefault();
        return;
      }
      if (e.key === "Backspace") {
        if (inputValue.length > 0 || selected.length === 0) {
          return;
        }
        e.preventDefault();
        const index =
          safeInlineFocusedIndex < 0 ||
          safeInlineFocusedIndex >= selected.length
            ? selected.length - 1
            : safeInlineFocusedIndex;
        const memberToRemove = selected.at(index);
        if (memberToRemove) {
          handleUnselectMember(memberToRemove);
        }
      } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        const newFocusedIndex = clamp(
          safeFocusedIndex + (e.key === "ArrowUp" ? -1 : 1),
          0,
          searchedMembers.length - 1,
        );
        const nextFocusedItem =
          scrollContainerRef.current?.querySelectorAll<HTMLElement>(
            '[data-testid="tag-selector-item"]',
          )[newFocusedIndex];
        nextFocusedItem?.scrollIntoView({ block: "nearest" });
        setFocusedIndex(newFocusedIndex);
        // reset inline focus
        setFocusedInlineIndex(selected.length + 1);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        if (inputValue.length > 0 || selected.length === 0) {
          return;
        }
        const newItemToFocus =
          e.key === "ArrowLeft"
            ? safeInlineFocusedIndex - 1
            : safeInlineFocusedIndex + 1;

        e.preventDefault();
        setFocusedInlineIndex(newItemToFocus);
        // reset tag list focus
        setFocusedIndex(-1);
      }
    },
    [
      inputValue.length,
      selected,
      safeInlineFocusedIndex,
      handleUnselectMember,
      safeFocusedIndex,
      searchedMembers.length,
    ],
  );

  return (
    <MenuPanel
      style={style}
      data-testid="tags-editor-popup"
      className={className}
      panelWidth="display"
      data-myoxus-ui-role="member-selector-panel"
    >
      <MenuSection data-myoxus-ui-role="member-selector-selected-members">
        <InlineMemberList
          members={selected}
          onRemove={handleUnselectMember}
          focusedIndex={safeInlineFocusedIndex}
        >
          <BadgeListItem grow data-myoxus-ui-role="member-selector-input-slot">
            <RowInput
              ref={inputRef}
              value={inputValue}
              onChange={onInputChange}
              onKeyDown={onInputKeyDown}
              onEnter={onEnter}
              autoFocus
              noBorder
              placeholder={t[
                "com.myoxus.settings.workspace.organization.members.user-search-placeholder"
              ]()}
            />
          </BadgeListItem>
        </InlineMemberList>
        {BUILD_CONFIG.isMobileEdition ? null : (
          <MenuItem
            aria-label={t["com.myoxus.member.invite.done"]()}
            prefixIcon={<DoneIcon />}
          />
        )}
      </MenuSection>
      {BUILD_CONFIG.isMobileEdition ? null : <MenuSeparator />}
      <MenuSection data-myoxus-ui-role="member-selector-results">
        <MenuScrollableSection
          ref={scrollContainerRef}
          maxHeight={BUILD_CONFIG.isMobileEdition ? "default" : "compact"}
        >
          {searchedMembers.length === 0 && (
            <MyoxusText
              component="div"
              tone="secondary"
              typographySlot="body-small"
            >
              Nothing here yet
            </MyoxusText>
          )}

          {searchedMembers.map((member, idx) => {
            return (
              <MenuItem
                key={member.id}
                active={safeFocusedIndex === idx}
                checked={selected.includes(member.id)}
                block
                closeMenuOnClick={
                  selectionMode === "single" && onSelectionComplete
                    ? false
                    : undefined
                }
                onSelect={() => onSelectTagOption(member)}
                onMouseEnter={() => setFocusedIndex(idx)}
                data-testid="tag-selector-item"
                data-focused={safeFocusedIndex === idx}
                data-member-id={member.id}
                data-member-name={member.name}
                prefix={
                  <Avatar
                    url={member.avatarUrl}
                    name={member.name ?? ""}
                    size="sm"
                  />
                }
              >
                <MemberSelectItem member={member} />
              </MenuItem>
            );
          })}
        </MenuScrollableSection>
      </MenuSection>
    </MenuPanel>
  );
};

const MobileMemberSelectorInline = ({
  readonly,
  placeholder,
  className,
  title,
  style,
  onEditorClose,
  ref,
  ...props
}: MemberSelectorInlineProps) => {
  const [editing, setEditing] = useState(false);

  useImperativeHandle(
    ref,
    () => ({
      changeOpen: (open: boolean) => {
        setEditing(open);
        if (!open) {
          onEditorClose?.();
        }
      },
    }),
    [onEditorClose],
  );

  const empty = !props.selected || props.selected.length === 0;
  const handleOpen = () => {
    if (!readonly) setEditing(true);
  };
  return (
    <>
      <ConfigModal
        title={title}
        open={editing}
        onOpenChange={setEditing}
        onBack={() => {
          setEditing(false);
          onEditorClose?.();
        }}
      >
        <MemberSelector
          {...props}
          onSelectionComplete={() => {
            setEditing(false);
            onEditorClose?.();
          }}
        />
      </ConfigModal>
      <MemberSelectorInlineSurface
        className={className}
        empty={empty}
        onClick={handleOpen}
        placeholder={placeholder}
        readonly={readonly}
        selected={props.selected}
        style={style}
      />
    </>
  );
};

const DesktopMemberSelectorInline = ({
  readonly,
  placeholder,
  className,
  modalMenu,
  menuClassName,
  style,
  selected,
  ref,
  onEditorClose,
  ...props
}: MemberSelectorInlineProps) => {
  const empty = !selected || selected.length === 0;
  const menuRef = useRef<MenuRef>(null);
  useImperativeHandle(
    ref,
    () => ({
      changeOpen: (open) => menuRef.current?.changeOpen(open),
    }),
    [],
  );
  return (
    <Menu
      ref={menuRef}
      contentOptions={{
        side: "bottom",
        align: "start",
        panelWidth: "display",
        className: menuClassName,
        onClick(e) {
          e.stopPropagation();
        },
      }}
      rootOptions={{
        open: readonly ? false : undefined,
        modal: modalMenu,
        onClose: onEditorClose,
      }}
      items={
        <MemberSelector
          selected={selected}
          {...props}
          onSelectionComplete={() => menuRef.current?.changeOpen(false)}
        />
      }
    >
      <MemberSelectorInlineSurface
        className={className}
        empty={empty}
        placeholder={placeholder}
        readonly={readonly}
        selected={selected}
        style={style}
      />
    </Menu>
  );
};

export const MemberSelectorInline = BUILD_CONFIG.isMobileEdition
  ? MobileMemberSelectorInline
  : DesktopMemberSelectorInline;
