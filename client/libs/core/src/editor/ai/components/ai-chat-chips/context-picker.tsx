// SPDX-License-Identifier: AGPL-3.0-or-later
import { useI18n } from "@myoxus/i18n";
import { PlusIcon } from "@myoxus/icons/react";
import {
  HiddenFileInput,
  IconButton,
  MyoxusLoader,
  Popover,
  PopoverContent,
  PopoverTarget,
  SearchCombobox,
  type SearchComboboxOption,
  Stack,
} from "@myoxus/ui-facade";
import type { Signal } from "@preact/signals-core";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

export function ContextPicker({
  disabled,
  renderContent,
  label,
  triggerIcon,
  testId = "chat-panel-with-button",
}: {
  disabled: boolean;
  renderContent: (controller: AbortController) => ReactNode;
  label?: string;
  triggerIcon?: ReactNode;
  testId?: string;
}) {
  const t = useI18n();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const controller = useMemo(
    () => (open ? new AbortController() : null),
    [open],
  );
  useEffect(() => {
    if (!controller) return;
    const close = () => setOpen(false);
    controller.signal.addEventListener("abort", close);
    return () => {
      controller.signal.removeEventListener("abort", close);
    };
  }, [controller]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const composer = trigger?.closest("ai-chat-composer");
    // Selecting the last overflow candidate removes its trigger. Native return
    // focus handles retained triggers; this fallback handles only that removal.
    return () =>
      queueMicrotask(() => {
        if (
          !trigger?.isConnected &&
          composer?.isConnected &&
          document.activeElement === document.body
        )
          composer
            .querySelector<HTMLButtonElement>(
              'button[data-testid="chat-panel-with-button"]',
            )
            ?.focus();
      });
  }, [open]);
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      position="bottom-start"
      contentMeasure="reading"
      fitViewport
      trapFocus
      returnFocus
      closeOnEscape
    >
      <PopoverTarget>
        <IconButton
          size="small"
          ref={triggerRef}
          data-testid={testId}
          aria-label={label ?? t["com.myoxus.ai.chat-panel.add-context"]()}
          tooltip={label ?? t["com.myoxus.ai.chat-panel.add-context"]()}
          tooltipOptions={{ opened: open ? false : undefined }}
          disabled={disabled}
          onClick={() => setOpen((value) => !value)}
        >
          {triggerIcon ?? <PlusIcon />}
        </IconButton>
      </PopoverTarget>
      <PopoverContent
        role="dialog"
        aria-label={label ?? t["com.myoxus.ai.chat-panel.add-context"]()}
      >
        {controller ? renderContent(controller) : null}
      </PopoverContent>
    </Popover>
  );
}

export interface ContextSearchOption extends SearchComboboxOption {
  action: () => void | Promise<void>;
}
export interface ContextSearchProps {
  query: Signal<string>;
  placeholder: string;
  options: ContextSearchOption[];
  loading?: boolean;
  onQueryChange: (query: string) => void;
  onFiles: (files: File[]) => void;
  onImages: (files: File[]) => void;
  onClose: () => void;
}

/** Uses the shared searchable native option contract; no document/context store. */
export function ContextSearch(props: ContextSearchProps) {
  const t = useI18n();
  const id = useId();
  const imageInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const subscribe = useCallback(
    (notify: () => void) => props.query.subscribe(notify),
    [props.query],
  );
  const query = useSyncExternalStore(subscribe, () => props.query.value);
  const [active, setActive] = useState(0);
  const options = props.options.map((option) => ({
    ...option,
    id: `${id}-${option.id}`,
  }));
  const commit = (option: SearchComboboxOption) => {
    if (props.loading || option.disabled) return;
    if (option.value === "images") {
      imageInput.current?.click();
      return;
    }
    if (option.value === "files") {
      fileInput.current?.click();
      return;
    }
    const item = props.options.find((item) => `${id}-${item.id}` === option.id);
    void item?.action();
  };
  return (
    <Stack data-testid="ai-add-popover">
      <SearchCombobox
        embedded
        value={query}
        placeholder={props.placeholder}
        isOpen
        listboxId={`${id}-options`}
        state={
          props.loading
            ? {
                kind: "loading",
                label: (
                  <>
                    <MyoxusLoader />
                    {t["Loading"]()}
                  </>
                ),
              }
            : props.options.length
              ? { kind: "options" }
              : { kind: "empty", label: t["com.myoxus.cmdk.no-results"]() }
        }
        options={options}
        activeDescendant={props.loading ? undefined : options[active]?.id}
        onInputChange={(value) => {
          setActive(0);
          props.onQueryChange(value);
        }}
        onInputFocus={() => {}}
        onOptionHover={setActive}
        onOptionCommit={commit}
        onClose={props.onClose}
        onInputKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (props.loading) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (props.options.length)
              setActive(
                (index) =>
                  (index +
                    (event.key === "ArrowDown" ? 1 : -1) +
                    props.options.length) %
                  props.options.length,
              );
          } else if (event.key === "Enter") {
            event.preventDefault();
            const option = options[active];
            if (option) commit(option);
          }
        }}
      />
      <HiddenFileInput
        ref={imageInput}
        accept="image/*"
        multiple
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          if (files.length) props.onImages(files);
        }}
      />
      <HiddenFileInput
        ref={fileInput}
        accept=".pdf,.txt,.csv,image/*"
        multiple
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          if (files.length) props.onFiles(files);
        }}
      />
    </Stack>
  );
}
