// SPDX-License-Identifier: AGPL-3.0-or-later
import { useI18n } from "@myoxus/i18n";
import type { ReactToLit } from "@myoxus/lit-react";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  SettingsIcon,
} from "@myoxus/icons/react";
import {
  Group,
  IconButton,
  InlineContentTrigger,
  MyoxusText,
  MyoxusTextInput,
  Popover,
  PopoverTarget,
  PopoverContent,
  Stack,
  Switch,
} from "@myoxus/ui-facade";
import {
  CalloutTitleHostExtension,
  type CalloutTitleHostProps,
} from "@virgultum/editor/blocks/callout";
import { useEffect, useRef, useState } from "react";

export function CalloutTitle({
  title,
  readonly,
  apply,
  focusEditor,
  type = "note",
  foldable = false,
  defaultOpen = true,
  expanded = true,
  toggle,
  applySettings,
}: CalloutTitleHostProps) {
  const t = useI18n();
  const [draft, setDraft] = useState(title);
  const [base, setBase] = useState(title);
  const [editing, setEditing] = useState(false);
  const cancelled = useRef(false);
  const [typeDraft, setTypeDraft] = useState(type);
  const typeCancelled = useRef(false);
  const [settingsOpened, setSettingsOpened] = useState(false);
  useEffect(() => setTypeDraft(type), [type]);
  useEffect(() => {
    if (!editing || readonly) {
      setDraft(title);
      setBase(title);
    }
  }, [title, editing, readonly]);
  const label =
    type.toLowerCase() === "note"
      ? t["com.myoxus.editor.callout.note"]()
      : type;
  const titleDisplay = (
    <MyoxusText typographySlot="heading-small">{title || label}</MyoxusText>
  );
  const titleControl = readonly ? (
    titleDisplay
  ) : !editing ? (
    <InlineContentTrigger
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        setEditing(true);
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {titleDisplay}
    </InlineContentTrigger>
  ) : (
    <MyoxusTextInput
      autoFocus
      noBorder
      block
      aria-label={label}
      placeholder={label}
      value={draft}
      onChange={setDraft}
      onFocus={() => {
        cancelled.current = false;
        setBase(title);
        setDraft(title);
        setEditing(true);
      }}
      onBlur={() => {
        if (!cancelled.current) apply(draft, base);
        setEditing(false);
      }}
      onPaste={(event) => event.stopPropagation()}
      onInput={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Escape") {
          cancelled.current = true;
          setDraft(title);
          setEditing(false);
          event.currentTarget.blur();
          focusEditor();
        }
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
          focusEditor();
        }
      }}
    />
  );
  if (!foldable && !applySettings) return titleControl;
  return (
    <Group wrap="nowrap" align="flex-start">
      {titleControl}
      {foldable && (
        <IconButton
          aria-label={expanded ? t["Collapse"]() : t["Expand"]()}
          aria-expanded={expanded}
          onClick={toggle}
        >
          {expanded ? <ChevronUpIcon /> : <ChevronDownIcon />}
        </IconButton>
      )}
      {!readonly && applySettings && (
        <Popover
          opened={settingsOpened}
          onChange={setSettingsOpened}
          closeOnEscape={false}
          trapFocus
          returnFocus
        >
          <PopoverTarget>
            <IconButton
              aria-label={t["Settings"]()}
              onClick={() => setSettingsOpened(!settingsOpened)}
            >
              <SettingsIcon />
            </IconButton>
          </PopoverTarget>
          <PopoverContent
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Escape" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                // Cancel before Mantine returns focus and blurs the type field.
                typeCancelled.current = true;
                setTypeDraft(type);
                setSettingsOpened(false);
              }
            }}
          >
            <Stack
              onKeyDown={(event) => {
                if (event.key !== "Escape" || event.nativeEvent.isComposing)
                  event.stopPropagation();
              }}
              onPaste={(event) => event.stopPropagation()}
              onInput={(event) => event.stopPropagation()}
            >
              <MyoxusTextInput
                label={t["com.myoxus.editor.callout.type"]()}
                value={typeDraft}
                onChange={(value) => {
                  typeCancelled.current = false;
                  setTypeDraft(value);
                }}
                onFocus={() => {
                  typeCancelled.current = false;
                }}
                error={!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(typeDraft)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return;
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.currentTarget.blur();
                  }
                  if (event.key === "Escape") {
                    typeCancelled.current = true;
                    setTypeDraft(type);
                  }
                }}
                onBlur={() => {
                  if (
                    typeCancelled.current ||
                    !applySettings({ type: typeDraft, foldable, defaultOpen })
                  )
                    setTypeDraft(type);
                }}
              />
              <Switch
                checked={foldable}
                onChange={(value) =>
                  applySettings({ type, foldable: value, defaultOpen })
                }
              >
                {t["com.myoxus.editor.callout.foldable"]()}
              </Switch>
              {foldable && (
                <Switch
                  checked={defaultOpen}
                  onChange={(value) =>
                    applySettings({ type, foldable, defaultOpen: value })
                  }
                >
                  {t["com.myoxus.editor.callout.default-open"]()}
                </Switch>
              )}
            </Stack>
          </PopoverContent>
        </Popover>
      )}
    </Group>
  );
}
export function patchCalloutTitleHost(reactToLit: ReactToLit) {
  return CalloutTitleHostExtension((props) =>
    reactToLit(<CalloutTitle {...props} />, true),
  );
}
