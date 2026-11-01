// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import { type MyoxusInputProps, Input } from "./input";
import {
  forwardRef,
  useState,
  useRef,
  useEffect,
  useCallback,
  type PropsWithChildren,
} from "react";
import { Box, Group, Stack, Center } from "@mantine/core";
import { SearchIcon } from "@myoxus/icons/react";
import { SafeArea } from "./safe-area";
import { type MyoxusButtonProps, MyoxusButton } from "./button";
import { type MyoxusTextProps, MyoxusText } from "./typography";
import { type RoleBoxProps } from "./helpers/ui-role";
import { MobileDocScroller, MobileDocStrip } from "./mobile-doc-rail";

export const MOBILE_SEARCH_VIEW_TRANSITION_NAME =
  "mx-mobile-search-input-48ccc7fb";

export const MOBILE_SEARCH_VIEW_TRANSITION_SCOPE = "mx-mobile-search-c95f18f6";

export type MobileSearchInputProps = Omit<
  MyoxusInputProps,
  "endFix" | "onChange" | "onInput" | "preFix"
> & {
  onInput?: (value: string) => void;
};

export const MobileSearchInput = forwardRef<
  HTMLInputElement,
  MobileSearchInputProps
>(function MobileSearchInput(
  {
    debounce,
    inputMode = "search",
    onInput,
    placeholder = "Search",
    style,
    type = "search",
    value = "",
    ...props
  },
  ref,
) {
  const [inputValue, setInputValue] = useState(String(value ?? ""));
  const debounceTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    setInputValue(String(value ?? ""));
  }, [value]);

  useEffect(() => {
    return () => {
      if (debounceTimeoutRef.current !== null) {
        window.clearTimeout(debounceTimeoutRef.current);
      }
    };
  }, []);

  const handleChange = useCallback(
    (nextValue: string) => {
      setInputValue(nextValue);
      if (!debounce || debounce <= 0) {
        onInput?.(nextValue);
        return;
      }
      if (debounceTimeoutRef.current !== null) {
        window.clearTimeout(debounceTimeoutRef.current);
      }
      debounceTimeoutRef.current = window.setTimeout(() => {
        onInput?.(nextValue);
      }, debounce);
    },
    [debounce, onInput],
  );

  return (
    <Box flex={1} miw={0} data-myoxus-ui-role="mobile-search-input-slot">
      <Input
        {...props}
        ref={ref}
        value={inputValue}
        type={type}
        inputMode={inputMode}
        placeholder={placeholder}
        onChange={handleChange}
        preFix={<SearchIcon />}
        data-myoxus-ui-role={
          props["data-myoxus-ui-role"] ?? "mobile-search-input"
        }
        block
        noBorder
        size="large"
        style={{
          viewTransitionName: MOBILE_SEARCH_VIEW_TRANSITION_NAME,
          ...style,
        }}
      />
    </Box>
  );
});

export function MobileSearchHeader({
  children,
  "data-testid": dataTestId,
}: PropsWithChildren<{ "data-testid"?: string }>) {
  return (
    <SafeArea
      top
      data-testid={dataTestId}
      data-myoxus-ui-role="mobile-search-header"
    >
      <Group gap="md" pb="md" px="md" wrap="nowrap">
        {children}
      </Group>
    </SafeArea>
  );
}

export function MobileSearchCancelButton({
  children,
  ...props
}: MyoxusButtonProps) {
  return (
    <MyoxusButton
      {...props}
      variant={props.variant ?? "plain"}
      data-myoxus-ui-role="mobile-search-cancel"
    >
      {children}
    </MyoxusButton>
  );
}

export function MobileSearchResultsTitle({
  children,
  ...props
}: MyoxusTextProps) {
  return (
    <MyoxusText
      {...props}
      component={props.component ?? "div"}
      mb="xs"
      px="md"
      py="xs"
      data-myoxus-ui-role="mobile-search-results-title"
      tone={props.tone ?? "secondary"}
      typographySlot={props.typographySlot ?? "body-small"}
    >
      {children}
    </MyoxusText>
  );
}

export function MobileSearchSection({
  children,
  horizontal = false,
  "data-testid": dataTestId,
}: PropsWithChildren<{ horizontal?: boolean; "data-testid"?: string }>) {
  return (
    <Stack
      data-horizontal={horizontal}
      data-testid={dataTestId}
      data-myoxus-ui-role="mobile-search-section"
      gap="xs"
      pb={horizontal ? undefined : "xl"}
    >
      {children}
    </Stack>
  );
}

export function MobileSearchSectionTitle({
  children,
  ...props
}: MyoxusTextProps) {
  return (
    <MyoxusText
      {...props}
      component={props.component ?? "div"}
      px="md"
      data-myoxus-ui-role="mobile-search-section-title"
      tone={props.tone ?? "primary"}
      typographySlot={props.typographySlot ?? "nav"}
    >
      {children}
    </MyoxusText>
  );
}

export function MobileSearchList({
  children,
  "data-testid": dataTestId,
}: PropsWithChildren<{ "data-testid"?: string }>) {
  return (
    <Stack
      data-testid={dataTestId}
      data-myoxus-ui-role="mobile-search-list"
      gap={0}
      px="md"
      py="sm"
    >
      {children}
    </Stack>
  );
}

export function MobileSearchDocScroller({
  children,
  className,
  ...props
}: RoleBoxProps) {
  return (
    <MobileDocScroller
      {...props}
      className={className}
      data-myoxus-ui-role="mobile-search-doc-scroller"
    >
      {children}
    </MobileDocScroller>
  );
}

export function MobileSearchDocStrip({
  children,
  className,
  ...props
}: RoleBoxProps) {
  return (
    <MobileDocStrip
      {...props}
      className={className}
      data-myoxus-ui-role="mobile-search-doc-strip"
    >
      {children}
    </MobileDocStrip>
  );
}

export function MobileSearchEmpty({ children, ...props }: MyoxusTextProps) {
  return (
    <Center px="md" py="xl" data-myoxus-ui-role="mobile-search-empty">
      <MyoxusText
        {...props}
        component={props.component ?? "div"}
        tone={props.tone ?? "secondary"}
        typographySlot={props.typographySlot ?? "body"}
      >
        {children}
      </MyoxusText>
    </Center>
  );
}

export function MobileSearchError({ children, ...props }: MyoxusTextProps) {
  return (
    <MyoxusText
      {...props}
      component={props.component ?? "p"}
      mb="md"
      px="md"
      data-myoxus-ui-role="mobile-search-error"
      tone={props.tone ?? "danger"}
      typographySlot={props.typographySlot ?? "body-small"}
    >
      {children}
    </MyoxusText>
  );
}
