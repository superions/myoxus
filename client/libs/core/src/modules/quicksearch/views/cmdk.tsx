// SPDX-License-Identifier: AGPL-3.0-or-later

import { i18nTime, isI18nString, useI18n } from "@myoxus/i18n";
import { SearchIcon } from "@myoxus/icons/react";
import {
  Alert,
  Box,
  Button,
  Center,
  DialogFooter,
  Group,
  Input,
  Kbd,
  Loading,
  MyoxusText,
  NavLink,
  SpotlightAction,
  SpotlightActionsGroup,
  SpotlightActionsList,
  SpotlightEmpty,
  SpotlightFooter,
  Stack,
  Text,
  ThemeIcon,
} from "@myoxus/ui-facade";
import {
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

import type { QuickSearchSourceState } from "../providers/quick-search-provider";
import type { QuickSearchGroup } from "../types/group";
import type { QuickSearchItem } from "../types/item";
import { HighlightText } from "./highlight-text";
import { QuickSearchSpotlightContext } from "./modal";

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
  const inSpotlight = useContext(QuickSearchSpotlightContext);
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
      // Control the currently selected item so async group updates keep selection stable.
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
        if (selectedExists) {
          return {
            ...state,
            groups: action.payload,
            selectedValue: prevSelectedValue,
          };
        }

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
  const selectedItemRef = useRef<HTMLButtonElement | null>(null);

  const handleValueChange = useCallback(
    (nextQuery: string) => {
      onQueryChange?.(nextQuery);
      dispatch({
        type: "reset-select",
      });
      requestAnimationFrame(() => {
        if (!listRef.current) return;
        const viewport =
          listRef.current.querySelector<HTMLElement>(
            ".mantine-ScrollArea-viewport",
          ) ?? listRef.current;
        viewport.scrollTop = 0;
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
      if ((event.target as Element).closest("button:not([role='option'])")) {
        return;
      }
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
    dispatch({
      type: "update-groups",
      payload: newGroups,
    });
  }, [newGroups]);

  useEffect(() => {
    const timeout = setTimeout(() => setLoading(newLoading), 1000);
    return () => clearTimeout(timeout);
  }, [newLoading]);

  useEffect(() => {
    selectedItemRef.current?.scrollIntoView({
      block: "nearest",
    });
  }, [selectedValue]);

  const isEmpty =
    !error &&
    !loading &&
    Boolean(query.trim()) &&
    groups.every(({ items, state }) => items.length === 0 && !state);

  const listContent = (
    <>
      {error ? (
        <Box px="sm" py="xs">
          <MyoxusText component="p" tone="danger" typographySlot="caption">
            {error}
          </MyoxusText>
        </Box>
      ) : null}
      {isEmpty ? (
        inSpotlight ? (
          <SpotlightEmpty>
            {i18n["com.myoxus.cmdk.no-results"]()}
          </SpotlightEmpty>
        ) : (
          <Center py="md">
            <MyoxusText tone="secondary" typographySlot="body">
              {i18n["com.myoxus.cmdk.no-results"]()}
            </MyoxusText>
          </Center>
        )
      ) : null}
      {groups.map(({ group, items, state }) => (
        <CMDKGroup
          key={group?.id ?? ""}
          inSpotlight={inSpotlight}
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
      ))}
    </>
  );

  return (
    <Stack
      gap={0}
      h="100%"
      mih={0}
      maw="100%"
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
        <Box px="md" pt="sm">
          <MyoxusText
            component="span"
            tone="secondary"
            typographySlot="caption"
          >
            {inputLabel}
          </MyoxusText>
        </Box>
      ) : null}
      <Box px="sm" py="xs">
        <Input
          id={inputId}
          data-autofocus
          variant="unstyled"
          noBorder
          block
          size="large"
          preFix={<SearchIcon aria-hidden="true" />}
          endFix={loading ? <Loading size="sm" /> : undefined}
          aria-label={placeholder}
          placeholder={placeholder}
          ref={inputRef}
          value={query}
          onChange={handleValueChange}
          aria-autocomplete="list"
          aria-controls={listId}
          aria-activedescendant={selectedValue || undefined}
        />
      </Box>

      {inSpotlight ? (
        <SpotlightActionsList
          data-cmdk-list=""
          id={listId}
          ref={listRef}
          mah={420}
          mih={0}
          role="listbox"
          aria-labelledby={inputId}
        >
          {listContent}
        </SpotlightActionsList>
      ) : (
        <Box
          data-cmdk-list=""
          id={listId}
          ref={listRef}
          role="listbox"
          aria-labelledby={inputId}
          mah={400}
          px="xs"
          py="xs"
          style={{ overflowY: "auto" }}
        >
          {listContent}
        </Box>
      )}

      {onOpenPage && query.trim() ? (
        inSpotlight ? (
          <SpotlightFooter>
            <Group justify="flex-end">
              <Button onClick={() => onOpenPage(query)}>
                {i18n["com.myoxus.search.results.open"]()}
              </Button>
            </Group>
          </SpotlightFooter>
        ) : (
          <DialogFooter>
            <Button onClick={() => onOpenPage(query)}>
              {i18n["com.myoxus.search.results.open"]()}
            </Button>
          </DialogFooter>
        )
      ) : null}
    </Stack>
  );
};

function GroupStatusFeedback({ state }: { state: QuickSearchSourceState }) {
  const i18n = useI18n();
  if (state.error) {
    return (
      <Alert color="myoxusError" mx="xs" my="xs">
        <Group justify="space-between" wrap="nowrap">
          <MyoxusText tone="danger" typographySlot="caption">
            {i18n["com.myoxus.common.operation-failed"]()}
          </MyoxusText>
          {state.retry ? (
            <Button type="button" variant="plain" onClick={state.retry}>
              {i18n["com.myoxus.error.retry"]()}
            </Button>
          ) : null}
        </Group>
      </Alert>
    );
  }
  if (!state.loading) return null;
  return (
    <Group gap="xs" px="sm" py="xs">
      <Loading size="sm" />
      <MyoxusText tone="secondary" typographySlot="caption">
        {i18n["com.myoxus.loading"]()}
      </MyoxusText>
    </Group>
  );
}

export const CMDKGroup = ({
  group: { group, items, state },
  inSpotlight = false,
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
  inSpotlight?: boolean;
  selectedItemRef: React.MutableRefObject<HTMLButtonElement | null>;
  selectedValue: string;
  onSelectChange: (value: string) => void;
  onSubmit?: (item: QuickSearchItem) => void;
  query: string;
  wrapLabels?: boolean;
}) => {
  const i18n = useI18n();
  const groupLabel = group ? i18n.t(group.label) : undefined;

  const renderedItems = items.map((item) => {
    const [title, subTitle] = isI18nString(item.label)
      ? [i18n.t(item.label), null]
      : [
          i18n.t(item.label.title),
          item.label.subTitle ? i18n.t(item.label.subTitle) : null,
        ];
    const selected = item.id === selectedValue;
    const isDanger =
      item.id === "editor:page-move-to-trash" ||
      item.id === "editor:edgeless-move-to-trash";

    const iconNode = item.icon ? (
      selected && inSpotlight ? (
        <Center aria-hidden="true">
          {typeof item.icon === "function" ? <item.icon /> : item.icon}
        </Center>
      ) : (
        <ThemeIcon
          variant="transparent"
          size="md"
          color={isDanger ? "myoxusError" : undefined}
        >
          {typeof item.icon === "function" ? <item.icon /> : item.icon}
        </ThemeIcon>
      )
    ) : null;

    const bodyNode = (
      <Stack
        flex={1}
        gap={0}
        miw={0}
        data-testid="cmdk-label"
        data-value={item.id}
      >
        {selected && inSpotlight ? (
          <Text component="div" truncate={!wrapLabels} size="body" c="inherit">
            <HighlightText text={title} start="<b>" end="</b>" />
          </Text>
        ) : (
          <MyoxusText
            component="div"
            truncate={!wrapLabels}
            tone={isDanger ? "danger" : "primary"}
            typographySlot="body"
          >
            <HighlightText text={title} start="<b>" end="</b>" />
          </MyoxusText>
        )}
        {subTitle ? (
          selected && inSpotlight ? (
            <Text
              component="div"
              truncate={!wrapLabels}
              size="caption"
              c="inherit"
              opacity={0.8}
            >
              <HighlightText text={subTitle} start="<b>" end="</b>" />
            </Text>
          ) : (
            <MyoxusText
              component="div"
              truncate={!wrapLabels}
              tone="secondary"
              typographySlot="caption"
            >
              <HighlightText text={subTitle} start="<b>" end="</b>" />
            </MyoxusText>
          )
        ) : null}
      </Stack>
    );

    const trailingNode =
      item.timestamp || item.keyBinding ? (
        <Group gap="xs" wrap="nowrap">
          {item.timestamp ? (
            selected && inSpotlight ? (
              <Text
                component="div"
                ta="end"
                size="caption"
                c="inherit"
                opacity={0.8}
              >
                {i18nTime(new Date(item.timestamp))}
              </Text>
            ) : (
              <MyoxusText
                component="div"
                ta="end"
                tone="secondary"
                typographySlot="caption"
              >
                {i18nTime(new Date(item.timestamp))}
              </MyoxusText>
            )
          ) : null}
          {item.keyBinding ? (
            <CMDKKeyBinding keyBinding={item.keyBinding} />
          ) : null}
        </Group>
      ) : null;

    if (inSpotlight) {
      return (
        <SpotlightAction
          key={item.id}
          id={item.id}
          ref={selected ? selectedItemRef : undefined}
          role="option"
          data-cmdk-item=""
          data-action={undefined}
          aria-selected={selected}
          aria-disabled={item.disabled || undefined}
          data-selected={selected ? "true" : undefined}
          disabled={item.disabled}
          onMouseEnter={() => {
            if (!item.disabled) onSelectChange(item.id);
          }}
          onClick={() => {
            if (!item.disabled) onSubmit?.(item);
          }}
        >
          <Group gap="sm" wrap="nowrap" w="100%" miw={0}>
            {iconNode}
            {bodyNode}
            {trailingNode}
          </Group>
        </SpotlightAction>
      );
    }

    return (
      <NavLink
        key={item.id}
        component="button"
        type="button"
        id={item.id}
        ref={selected ? selectedItemRef : undefined}
        role="option"
        tabIndex={-1}
        data-cmdk-item=""
        active={selected}
        disabled={item.disabled}
        color={isDanger ? "myoxusError" : undefined}
        aria-selected={selected}
        aria-disabled={item.disabled || undefined}
        data-selected={selected ? "true" : undefined}
        leftSection={iconNode}
        rightSection={trailingNode}
        label={bodyNode}
        onMouseEnter={() => {
          if (!item.disabled) onSelectChange(item.id);
        }}
        onClick={() => {
          if (!item.disabled) onSubmit?.(item);
        }}
      />
    );
  });

  if (inSpotlight) {
    return (
      <SpotlightActionsGroup
        key={`${query}:${group?.id ?? ""}`}
        data-cmdk-group=""
        role="group"
        label={groupLabel}
        aria-label={groupLabel}
      >
        {state ? <GroupStatusFeedback state={state} /> : null}
        {renderedItems}
      </SpotlightActionsGroup>
    );
  }

  return (
    <Stack
      key={`${query}:${group?.id ?? ""}`}
      gap={2}
      data-cmdk-group=""
      role="group"
      aria-label={groupLabel}
    >
      {groupLabel ? (
        <Box px="sm" pt="xs">
          <MyoxusText
            component="div"
            tone="secondary"
            typographySlot="caption"
            data-cmdk-group-heading=""
          >
            {groupLabel}
          </MyoxusText>
        </Box>
      ) : null}
      {state ? <GroupStatusFeedback state={state} /> : null}
      {renderedItems}
    </Stack>
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
    <Group gap={4} wrap="nowrap">
      {fragments.map((fragment) => (
        <Kbd key={fragment} size="sm">
          {fragment}
        </Kbd>
      ))}
    </Group>
  );
};
