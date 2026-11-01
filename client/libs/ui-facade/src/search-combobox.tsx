// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import {
  type ReactNode,
  type KeyboardEventHandler,
  useEffect,
  useCallback,
} from "react";
import {
  useCombobox as useMantineCombobox,
  Combobox as MantineCombobox,
  TextInput,
  Group,
  Stack,
  Text,
  ScrollArea,
} from "@mantine/core";
import { cssVar } from "@myoxus/theme";
import { useIsInsideModal } from "./modal";

export type SearchComboboxOption = {
  group?: string;
  disabled?: boolean;
  value: string;
  id: string;
  title: ReactNode;
  meta?: ReactNode;
  code?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  active?: boolean;
  selected?: boolean;
  testId?: string;
};

export type SearchComboboxState =
  | {
      kind: "idle" | "loading" | "error" | "empty";
      label: ReactNode;
      testId?: string;
    }
  | { kind: "options" };

export type SearchComboboxProps = {
  /** Reuse an enclosing popup's focus/position owner instead of another dropdown. */
  embedded?: boolean;
  value: string;
  placeholder: string;
  label?: ReactNode;
  disabled?: boolean;
  isOpen: boolean;
  listboxId: string;
  activeDescendant?: string;
  state: SearchComboboxState;
  options: SearchComboboxOption[];
  className?: string;
  inputId?: string;
  "data-testid"?: string;
  "aria-label"?: string;
  onInputChange: (value: string) => void;
  onInputFocus: () => void;
  onInputKeyDown: KeyboardEventHandler<HTMLInputElement>;
  onOptionCommit: (option: SearchComboboxOption) => void;
  onOptionHover?: (index: number) => void;
  onClose?: () => void;
};

export function SearchCombobox({
  embedded = false,
  value,
  placeholder,
  label,
  disabled,
  isOpen,
  listboxId,
  activeDescendant,
  state,
  options,
  className,
  inputId,
  "data-testid": dataTestId,
  "aria-label": ariaLabel,
  onInputChange,
  onInputFocus,
  onInputKeyDown,
  onOptionCommit,
  onOptionHover,
  onClose,
}: SearchComboboxProps) {
  const insideModal = useIsInsideModal();
  const combobox = useMantineCombobox({
    opened: isOpen,
    onOpenedChange: (opened) => {
      if (!opened) onClose?.();
    },
  });

  useEffect(() => {
    if (activeDescendant) {
      const activeIndex = options.findIndex(
        (option) => option.id === activeDescendant,
      );
      if (activeIndex >= 0) {
        combobox.updateSelectedOptionIndex(activeIndex);
      }
    }
  }, [activeDescendant, combobox, options]);

  const commitOptionById = useCallback(
    (optionId: string) => {
      const option = options.find((item) => item.id === optionId);
      if (option) {
        onOptionCommit(option);
      }
    },
    [onOptionCommit, options],
  );

  const renderOption = (option: SearchComboboxOption, index: number) => (
    <MantineCombobox.Option
      key={option.id}
      id={option.id}
      value={option.id}
      disabled={option.disabled}
      selected={option.selected ?? option.active}
      // Mantine's selected rule hardcodes white; neutral theme roles keep
      // nested result metadata readable in the selected option.
      style={
        (option.selected ?? option.active)
          ? {
              backgroundColor: cssVar("hoverColor"),
              color: cssVar("textPrimaryColor"),
            }
          : undefined
      }
      data-testid={option.testId}
      onMouseEnter={() => onOptionHover?.(index)}
    >
      <Group gap="sm" wrap="nowrap" align="center">
        {option.leading}
        <Stack gap={0} flex={1} miw={0}>
          <Text component="span" fw={500} truncate>
            {option.title}
          </Text>
          {option.meta ? (
            <Text component="span" size="caption" c="dimmed" truncate>
              {option.meta}
            </Text>
          ) : null}
          {option.code ? (
            <Text component="span" size="caption" c="dimmed" truncate>
              {option.code}
            </Text>
          ) : null}
        </Stack>
        {option.trailing}
      </Group>
    </MantineCombobox.Option>
  );
  const groups = Map.groupBy(options, (option) => option.group);
  const optionList = (
    <MantineCombobox.Options
      id={listboxId}
      aria-label={ariaLabel ?? placeholder}
    >
      {state.kind === "options" ? (
        [...groups].map(([label, items]) =>
          label ? (
            <MantineCombobox.Group key={label} label={label}>
              {items.map((option) =>
                renderOption(option, options.indexOf(option)),
              )}
            </MantineCombobox.Group>
          ) : (
            items.map((option) => renderOption(option, options.indexOf(option)))
          ),
        )
      ) : (
        <MantineCombobox.Empty
          data-state={state.kind}
          data-testid={state.testId}
          aria-live="polite"
        >
          {state.label}
        </MantineCombobox.Empty>
      )}
    </MantineCombobox.Options>
  );

  return (
    <Stack
      gap={embedded ? "xs" : 0}
      mah={
        embedded
          ? "calc(var(--myoxus-popover-available-height, 100dvh) - var(--mantine-spacing-md) * 2)"
          : undefined
      }
      mih={0}
      className={className}
      data-testid={dataTestId}
      data-myoxus-ui-role="search-combobox"
    >
      <MantineCombobox
        store={combobox}
        onOptionSubmit={commitOptionById}
        withinPortal={!insideModal}
      >
        <MantineCombobox.Target
          withAriaAttributes={false}
          withKeyboardNavigation={false}
        >
          <TextInput
            id={inputId}
            label={label}
            role="combobox"
            type="text"
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            placeholder={placeholder}
            value={value}
            aria-label={ariaLabel ?? placeholder}
            aria-expanded={isOpen}
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={activeDescendant}
            data-myoxus-ui-role="search-combobox-input"
            // Custom ARIA ownership disables Combobox.Target's native marker.
            // Modal handles Escape in window capture, before React key handlers.
            data-mantine-stop-propagation={isOpen || undefined}
            onChange={(event) => onInputChange(event.currentTarget.value)}
            onFocus={onInputFocus}
            onKeyDown={onInputKeyDown}
          />
        </MantineCombobox.Target>

        {embedded ? (
          <ScrollArea.Autosize
            mih={0}
            scrollbars="y"
            offsetScrollbars
            data-myoxus-ui-role="search-combobox-embedded-options"
          >
            {optionList}
          </ScrollArea.Autosize>
        ) : (
          <MantineCombobox.Dropdown data-myoxus-ui-role="search-combobox-menu">
            {optionList}
          </MantineCombobox.Dropdown>
        )}
      </MantineCombobox>
    </Stack>
  );
}
