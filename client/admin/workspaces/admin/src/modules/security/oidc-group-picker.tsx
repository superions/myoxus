// SPDX-License-Identifier: AGPL-3.0-or-later
import { useI18n } from "@myoxus/i18n";
import { AdminOidcDirectoryEntryState } from "@myoxus/graphql";
import {
  Checkbox,
  Input,
  SearchCombobox,
  Stack,
  type SearchComboboxOption,
} from "@myoxus/ui-facade";
import { useEffect, useId, useState } from "react";

import type { OidcDirectoryState } from "./oidc-group-directory";

/** Search text is not a rule edit. Only committing a selectable server claim
 * value, or explicitly switching to manual input, changes the persisted draft.
 */
export function OidcGroupPicker({
  value,
  onChange,
  directory,
  blockedMessage,
}: {
  value: string;
  onChange: (value: string) => void;
  directory: OidcDirectoryState;
  blockedMessage?: string;
}) {
  const i18n = useI18n();
  const prefix = useId();
  const [manual, setManual] = useState(false);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [highlight, setHighlight] = useState(-1);
  useEffect(() => {
    setHighlight(-1);
  }, [directory, blockedMessage]);
  const entries =
    !blockedMessage && directory.kind === "loaded" ? directory.entries : [];
  const needle = search.toLocaleLowerCase(i18n.language);
  const options: SearchComboboxOption[] = entries
    .filter((entry) =>
      [entry.displayName, entry.path, entry.claimValue].some((text) =>
        text?.toLocaleLowerCase(i18n.language).includes(needle),
      ),
    )
    .map((entry, index) => ({
      id: `${prefix}-${index}`,
      value: entry.claimValue ?? "",
      title: entry.displayName,
      meta: entry.path,
      code: entry.claimValue,
      disabled:
        entry.state !== AdminOidcDirectoryEntryState.AVAILABLE ||
        !entry.claimValue,
      trailing:
        entry.state === AdminOidcDirectoryEntryState.AMBIGUOUS
          ? i18n.t("admin.security.oauth.directory-ambiguous")
          : entry.state === AdminOidcDirectoryEntryState.UNAVAILABLE
            ? i18n.t("com.myoxus.reference.target-unavailable")
            : undefined,
      selected: index === highlight,
    }));
  const commit = (option: SearchComboboxOption) => {
    if (option.disabled) return;
    onChange(option.value);
    setSearch("");
    setOpen(false);
    setHighlight(-1);
  };
  const selectable = options.flatMap((option, index) =>
    option.disabled ? [] : [index],
  );
  const active = options[highlight];
  return (
    <Stack>
      {manual ? (
        <Input
          value={value}
          onChange={onChange}
          placeholder="finance/managers"
          aria-label={i18n.t("admin.security.oauth.provider-group")}
        />
      ) : (
        <SearchCombobox
          value={open ? search : value}
          placeholder="finance/managers"
          aria-label={i18n.t("admin.security.oauth.provider-group")}
          isOpen={open}
          listboxId={`${prefix}-listbox`}
          activeDescendant={
            open && active && !active.disabled ? active.id : undefined
          }
          options={options}
          state={
            blockedMessage
              ? { kind: "idle", label: blockedMessage }
              : directory.kind === "loading"
                ? { kind: "loading", label: i18n.t("admin.common.loading") }
                : directory.kind === "error"
                  ? { kind: "error", label: directory.message }
                  : directory.kind === "idle"
                    ? {
                        kind: "idle",
                        label: i18n.t("admin.security.oauth.directory-idle"),
                      }
                    : entries.length === 0
                      ? {
                          kind: "empty",
                          label: i18n.t("admin.security.oauth.directory-empty"),
                        }
                      : options.length === 0
                        ? {
                            kind: "empty",
                            label: i18n.t("admin.state.no-results"),
                          }
                        : { kind: "options" }
          }
          onInputFocus={() => {
            setSearch("");
            setHighlight(-1);
            setOpen(true);
          }}
          onInputChange={(text) => {
            setSearch(text);
            setHighlight(-1);
            setOpen(true);
          }}
          onClose={() => {
            setOpen(false);
            setSearch("");
            setHighlight(-1);
          }}
          onOptionCommit={commit}
          onOptionHover={(index) => {
            if (!options[index]?.disabled) setHighlight(index);
          }}
          onInputKeyDown={(event) => {
            if (event.key === "Escape" || event.key === "Tab") {
              setOpen(false);
              setSearch("");
              setHighlight(-1);
              return;
            }
            if (event.key === "Enter") {
              if (open && active && !active.disabled) {
                event.preventDefault();
                commit(active);
              }
              return;
            }
            if (
              !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) ||
              (!open && ["Home", "End"].includes(event.key))
            )
              return;
            event.preventDefault();
            setOpen(true);
            if (selectable.length === 0) return;
            const current = selectable.indexOf(highlight);
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? selectable.length - 1
                  : event.key === "ArrowDown"
                    ? (current + 1) % selectable.length
                    : current <= 0
                      ? selectable.length - 1
                      : current - 1;
            setHighlight(selectable[next]);
          }}
        />
      )}
      <Checkbox
        label={i18n.t("admin.security.oauth.directory-manual")}
        checked={manual}
        onChange={(_, checked) => {
          setManual(checked);
          setOpen(false);
          setSearch("");
          setHighlight(-1);
        }}
      />
    </Stack>
  );
}
