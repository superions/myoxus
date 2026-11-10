import { i18nTime, isI18nString, useI18n } from "@myoxus/i18n";
import {
  Button,
  DialogFooter,
  CommandPaletteEmpty,
  CommandPaletteError,
  CommandPaletteGroup,
  CommandPaletteGroupHeading,
  CommandPaletteGroupStatus,
  CommandPaletteInput,
  CommandPaletteItem,
  CommandPaletteItemBody,
  CommandPaletteItemIcon,
  CommandPaletteItemSubtitle,
  CommandPaletteItemTitle,
  CommandPaletteList,
  CommandPaletteRoot,
  CommandPaletteSearchRow,
  CommandPaletteShortcut,
  CommandPaletteShortcutKey,
  CommandPaletteTimestamp,
  CommandPaletteTitle,
  CommandPaletteTitleRow,
} from "@myoxus/ui-facade";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

import type { QuickSearchSourceState } from "../providers/quick-search-provider";
import type { QuickSearchGroup } from "../types/group";
import type { QuickSearchItem } from "../types/item";
import { HighlightText } from "./highlight-text";

type Groups = {
  group?: QuickSearchGroup;
  items: QuickSearchItem[];
  state?: QuickSearchSourceState;
}[];

const EMPTY_GROUPS: Groups = [];

function enabledItems(groups: Groups) {
  return groups.flatMap(({ items }) => items.filter((item) => !item.disabled));
}

function firstSearchResult(groups: Groups) {
  // Creating from query text requires a deliberate selection, including while
  // asynchronous search sources have not returned their first result yet.
  return enabledItems(groups).find((item) => item.source !== "creation");
}

export const CMDK = ({
  className,
  query,
  groups: newGroups = EMPTY_GROUPS,
  error,
  inputLabel,
  wrapLabels = false,
  placeholder,
  loading: newLoading = false,
  onQueryChange,
  onSubmit,
  onOpenPage,
}: React.PropsWithChildren<{
  className?: string;
  query: string;
  error?: ReactNode;
  inputLabel?: ReactNode;
  wrapLabels?: boolean;
  placeholder?: string;
  loading?: boolean;
  groups?: Groups;
  onSubmit?: (item: QuickSearchItem) => void;
  onOpenPage?: (query: string) => void;
  onQueryChange?: (query: string) => void;
}>) => {
  const i18n = useI18n();
  const [opening, setOpening] = useState(false);
  const [loading, setLoading] = useState(false);
  const listId = useId();
  const inputId = useId();

  const [{ groups, selectedValue }, dispatch] = useReducer(
    (
      state: {
        groups: Groups;
        selectedValue: string;
      },
      action:
        | { type: "select"; payload: string }
        | { type: "reset-select" }
        | { type: "update-groups"; payload: Groups },
    ) => {
      // control the currently selected item so that when the item list changes, the selected item remains controllable
      if (action.type === "select") {
        return {
          ...state,
          selectedValue: action.payload,
        };
      }
      if (action.type === "reset-select") {
        const firstItem = firstSearchResult(state.groups)?.id;
        return {
          ...state,
          selectedValue: firstItem ?? "",
        };
      }
      if (action.type === "update-groups") {
        const prevGroups = state.groups;
        const prevSelectedValue = state.selectedValue;

        const prevFirstItem = firstSearchResult(prevGroups)?.id ?? "";
        const newFirstItem = firstSearchResult(action.payload)?.id ?? "";
        const isSelectingFirstItem = prevSelectedValue === prevFirstItem;
        // if previous selected item is the first item, select the new first item
        if (isSelectingFirstItem) {
          return {
            ...state,
            groups: action.payload,
            selectedValue: newFirstItem ?? "",
          };
        }

        const selectedExists = action.payload.some(({ items }) =>
          items.some((item) => item.id === prevSelectedValue),
        );
        // if previous selected item exists in the new list, keep it
        if (selectedExists) {
          return {
            ...state,
            groups: action.payload,
            selectedValue: prevSelectedValue,
          };
        }

        // if previous selected item does not exist in the new list, select the new first item
        return {
          ...state,
          groups: action.payload,
          selectedValue: newFirstItem ?? "",
        };
      }
      return state;
    },
    { groups: [], selectedValue: "" },
  );

  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedItemRef = useRef<HTMLDivElement | null>(null);

  // fix list height animation on opening
  useLayoutEffect(() => {
    setOpening(true);
    const timeout = setTimeout(() => {
      setOpening(false);
      inputRef.current?.focus();
    }, 150);
    return () => {
      clearTimeout(timeout);
    };
  }, []);

  const handleValueChange = useCallback(
    (query: string) => {
      onQueryChange?.(query);
      dispatch({
        type: "reset-select",
      });
      requestAnimationFrame(() => {
        if (listRef.current) listRef.current.scrollTop = 0;
      });
    },
    [onQueryChange],
  );

  const handleSelectChange = useCallback(
    (value: string) => {
      dispatch({
        type: "select",
        payload: value,
      });
    },
    [dispatch],
  );

  const selectRelative = useCallback(
    (delta: number) => {
      const items = enabledItems(groups);
      if (items.length === 0) return;

      const currentIndex = items.findIndex((item) => item.id === selectedValue);
      const nextIndex =
        currentIndex === -1
          ? delta > 0
            ? 0
            : items.length - 1
          : (currentIndex + delta + items.length) % items.length;

      handleSelectChange(items[nextIndex]?.id ?? "");
    },
    [groups, handleSelectChange, selectedValue],
  );

  const selectBoundary = useCallback(
    (position: "first" | "last") => {
      const items = enabledItems(groups);
      const item = position === "first" ? items.at(0) : items.at(-1);
      if (item) handleSelectChange(item.id);
    },
    [groups, handleSelectChange],
  );

  const submitSelected = useCallback(() => {
    // A query can change before the reducer has projected its new groups.
    // Never submit a result that is absent from the current search results.
    const items = enabledItems(newGroups);
    const selected =
      items.find((item) => item.id === selectedValue) ??
      firstSearchResult(newGroups);
    if (selected) onSubmit?.(selected);
  }, [newGroups, onSubmit, selectedValue]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      // Footer and source-retry buttons retain native Tab/Enter activation.
      if ((event.target as Element).closest("button")) return;
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          selectRelative(1);
          break;
        case "ArrowUp":
          event.preventDefault();
          selectRelative(-1);
          break;
        case "Home":
          event.preventDefault();
          selectBoundary("first");
          break;
        case "End":
          event.preventDefault();
          selectBoundary("last");
          break;
        case "Enter":
          event.preventDefault();
          submitSelected();
          break;
        default:
          break;
      }
    },
    [selectBoundary, selectRelative, submitSelected],
  );

  useEffect(() => {
    // on group change
    dispatch({
      type: "update-groups",
      payload: newGroups,
    });
  }, [newGroups]);

  useEffect(() => {
    // debounce loading state
    const timeout = setTimeout(() => setLoading(newLoading), 1000);
    return () => clearTimeout(timeout);
  }, [newLoading]);

  useEffect(() => {
    selectedItemRef.current?.scrollIntoView({
      block: "nearest",
    });
  }, [selectedValue]);

  return (
    <CommandPaletteRoot
      data-cmdk-root=""
      data-testid="cmdk-quick-search"
      role="combobox"
      aria-controls={listId}
      aria-expanded="true"
      aria-haspopup="listbox"
      className={className}
      onKeyDown={handleKeyDown}
    >
      {inputLabel ? (
        <CommandPaletteTitleRow>
          <CommandPaletteTitle>{inputLabel}</CommandPaletteTitle>
        </CommandPaletteTitleRow>
      ) : null}
      <CommandPaletteSearchRow hasLabel={!!inputLabel}>
        <CommandPaletteInput
          id={inputId}
          data-autofocus
          aria-label={placeholder}
          placeholder={placeholder}
          ref={inputRef}
          value={query}
          onChange={handleValueChange}
          aria-autocomplete="list"
          aria-controls={listId}
          aria-activedescendant={selectedValue || undefined}
          loading={loading}
        />
      </CommandPaletteSearchRow>

      <CommandPaletteList
        data-cmdk-list=""
        id={listId}
        ref={listRef}
        role="listbox"
        aria-labelledby={inputId}
        data-opening={opening ? true : undefined}
      >
        {error && <CommandPaletteError>{error}</CommandPaletteError>}
        {!error &&
        !loading &&
        query.trim() &&
        groups.every(({ items, state }) => items.length === 0 && !state) ? (
          <CommandPaletteEmpty>
            {i18n["com.myoxus.cmdk.no-results"]()}
          </CommandPaletteEmpty>
        ) : null}
        {groups.map(({ group, items, state }) => {
          return (
            <CMDKGroup
              key={group?.id ?? ""}
              selectedItemRef={selectedItemRef}
              selectedValue={selectedValue}
              onSelectChange={handleSelectChange}
              onSubmit={onSubmit}
              query={query}
              wrapLabels={wrapLabels}
              group={{
                group,
                items,
                state,
              }}
            />
          );
        })}
      </CommandPaletteList>
      {onOpenPage && query.trim() ? (
        <DialogFooter>
          <Button onClick={() => onOpenPage(query)}>
            {i18n["com.myoxus.search.results.open"]()}
          </Button>
        </DialogFooter>
      ) : null}
    </CommandPaletteRoot>
  );
};

export const CMDKGroup = ({
  group: { group, items, state },
  selectedItemRef,
  selectedValue,
  onSelectChange,
  onSubmit,
  query,
  wrapLabels = false,
}: {
  group: {
    group?: QuickSearchGroup;
    items: QuickSearchItem[];
    state?: QuickSearchSourceState;
  };
  selectedItemRef: React.MutableRefObject<HTMLDivElement | null>;
  selectedValue: string;
  onSelectChange: (value: string) => void;
  onSubmit?: (item: QuickSearchItem) => void;
  query: string;
  wrapLabels?: boolean;
}) => {
  const i18n = useI18n();
  return (
    <CommandPaletteGroup
      data-cmdk-group=""
      key={query + ":" + (group?.id ?? "")}
      role="group"
      aria-label={group ? i18n.t(group.label) : undefined}
    >
      {group ? (
        <CommandPaletteGroupHeading data-cmdk-group-heading="">
          {i18n.t(group.label)}
        </CommandPaletteGroupHeading>
      ) : null}
      {state ? (
        <CommandPaletteGroupStatus
          error={
            state.error
              ? i18n["com.myoxus.common.operation-failed"]()
              : undefined
          }
          loading={state.loading}
          loadingLabel={i18n["com.myoxus.loading"]()}
          retryLabel={i18n["com.myoxus.error.retry"]()}
          onRetry={state.retry}
        />
      ) : null}
      {items.map((item) => {
        const [title, subTitle] = isI18nString(item.label)
          ? [i18n.t(item.label), null]
          : [
              i18n.t(item.label.title),
              item.label.subTitle ? i18n.t(item.label.subTitle) : null,
            ];
        const selected = item.id === selectedValue;

        return (
          <CommandPaletteItem
            data-cmdk-item=""
            id={item.id}
            key={item.id}
            ref={selected ? selectedItemRef : undefined}
            selected={selected}
            disabled={item.disabled}
            tone={
              item.id === "editor:page-move-to-trash" ||
              item.id === "editor:edgeless-move-to-trash"
                ? "danger"
                : "default"
            }
            onMouseEnter={() => {
              if (!item.disabled) onSelectChange(item.id);
            }}
            onClick={() => {
              if (!item.disabled) onSubmit?.(item);
            }}
          >
            <CommandPaletteItemIcon>
              {item.icon &&
                (typeof item.icon === "function" ? <item.icon /> : item.icon)}
            </CommandPaletteItemIcon>
            <CommandPaletteItemBody
              data-testid="cmdk-label"
              data-value={item.id}
            >
              <CommandPaletteItemTitle truncate={!wrapLabels}>
                <HighlightText text={title} start="<b>" end="</b>" />
              </CommandPaletteItemTitle>
              {subTitle && (
                <CommandPaletteItemSubtitle truncate={!wrapLabels}>
                  <HighlightText text={subTitle} start="<b>" end="</b>" />
                </CommandPaletteItemSubtitle>
              )}
            </CommandPaletteItemBody>
            {item.timestamp ? (
              <CommandPaletteTimestamp>
                {i18nTime(new Date(item.timestamp))}
              </CommandPaletteTimestamp>
            ) : null}
            {item.keyBinding ? (
              <CMDKKeyBinding keyBinding={item.keyBinding} />
            ) : null}
          </CommandPaletteItem>
        );
      })}
    </CommandPaletteGroup>
  );
};

const CMDKKeyBinding = ({ keyBinding }: { keyBinding: string }) => {
  const isMacOS = environment.isMacOs;
  const fragments = useMemo(() => {
    return keyBinding.split("+").map((fragment) => {
      if (fragment === "$mod") {
        return isMacOS ? "⌘" : "Ctrl";
      }
      if (fragment === "Alt") {
        return isMacOS ? "⌥" : "Alt";
      }
      if (fragment.startsWith("Key")) {
        return fragment.slice(3);
      }
      if (fragment === "ArrowUp") {
        return "↑";
      }
      if (fragment === "ArrowDown") {
        return "↓";
      }
      if (fragment === "ArrowLeft") {
        return "←";
      }
      if (fragment === "ArrowRight") {
        return "→";
      }
      return fragment;
    });
  }, [isMacOS, keyBinding]);

  return (
    <CommandPaletteShortcut>
      {fragments.map((fragment) => {
        return (
          <CommandPaletteShortcutKey key={fragment}>
            {fragment}
          </CommandPaletteShortcutKey>
        );
      })}
    </CommandPaletteShortcut>
  );
};
