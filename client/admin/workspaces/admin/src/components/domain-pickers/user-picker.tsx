/**
 * Admin domain picker — UserPicker (P-AR-0-03).
 *
 * Combobox-style user picker with two permission surfaces:
 *
 * - `mode="admin"` → calls `adminSearchUsersQuery` (admin-only); optional
 *   `features` filter narrows results to users carrying those feature flags.
 * - `mode="manager"` → calls `managerSearchUsersQuery` and **requires**
 *   `unitId` so the server can scope results to manageable users only.
 *
 * The discriminated-union prop type guarantees at compile-time that
 * `mode="manager"` cannot be used without a `unitId`, and that `features`
 * is only accepted on the admin surface.
 *
 * Visual: Facade `SearchCombobox`, Facade avatars and facade-backed StatusDot
 * badges. Domain logic here is limited to query selection and result mapping.
 */
import {
  adminSearchUsersQuery,
  managerSearchUsersQuery,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { Avatar, SearchCombobox, StatusDot } from "@myoxus/ui-facade";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";

import { gqlFetcher } from "../../use-query";

type UserOption = {
  id: string;
  email: string;
  name: string;
  features: ReadonlyArray<string>;
  isAdmin?: boolean;
};

type AdminMode = { mode: "admin"; features?: string[]; excludeUnitId?: string };
type ManagerMode = { mode: "manager"; unitId: string };

export type UserPickerProps = (AdminMode | ManagerMode) & {
  value: string | null;
  onChange: (id: string | null) => void;
  placeholder?: string;
  label?: string;
  disabled?: boolean;
  "data-testid"?: string;
};

const DEBOUNCE_MS = 200;

/** Two-letter monogram from the local-part of an email (uppercased). */
function monogramFromEmail(email: string): string {
  const local = email.split("@")[0] ?? email;
  const cleaned = local.replace(/[^A-Za-z0-9]/g, "");
  return (cleaned.slice(0, 2) || "??").toUpperCase();
}

export function UserPicker(props: UserPickerProps) {
  const i18n = useI18n();
  const inputId = useId();
  const listboxId = useId();

  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [options, setOptions] = useState<UserOption[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // Debounce search input → server query.
  useEffect(() => {
    const handle = setTimeout(() => setDebounced(query.trim()), DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query]);

  const shouldFetch = debounced.length >= 1;
  const adminFeaturesKey =
    props.mode === "admin" && props.features?.length
      ? props.features.join("\0")
      : "";
  const adminExcludeUnitId =
    props.mode === "admin" ? (props.excludeUnitId ?? null) : null;
  const managerUnitId = props.mode === "manager" ? props.unitId : null;

  useEffect(() => {
    if (!shouldFetch) {
      setOptions([]);
      setIsLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setError(null);

    if (props.mode === "admin") {
      gqlFetcher({
        query: adminSearchUsersQuery,
        variables: {
          query: debounced,
          limit: 50,
          features: adminFeaturesKey ? adminFeaturesKey.split("\0") : null,
          excludeUnitId: adminExcludeUnitId,
        },
      })
        .then((data) => {
          if (cancelled) return;
          setOptions((data.admin?.adminSearchUsers ?? []) as UserOption[]);
        })
        .catch((cause) => {
          if (cancelled) return;
          console.warn("UserPicker search failed", {
            mode: props.mode,
            query: debounced,
            cause,
          });
          setError(cause);
          setOptions([]);
        })
        .finally(() => {
          if (!cancelled) setIsLoading(false);
        });
    } else {
      gqlFetcher({
        query: managerSearchUsersQuery,
        variables: {
          query: debounced,
          unitId: managerUnitId ?? "",
          limit: 50,
        },
      })
        .then((data) => {
          if (cancelled) return;
          setOptions((data.managerSearchUsers ?? []) as UserOption[]);
        })
        .catch((cause) => {
          if (cancelled) return;
          console.warn("UserPicker search failed", {
            mode: props.mode,
            query: debounced,
            cause,
          });
          setError(cause);
          setOptions([]);
        })
        .finally(() => {
          if (!cancelled) setIsLoading(false);
        });
    }

    return () => {
      cancelled = true;
    };
  }, [
    adminExcludeUnitId,
    adminFeaturesKey,
    debounced,
    managerUnitId,
    props.mode,
    shouldFetch,
  ]);

  /*
    The picker intentionally bypasses SWR for the keystroke search above:
    the previous null-key -> dynamic-key flow could render an empty list
    without issuing `adminSearchUsers` after a debounced query transition.
    A local effect keeps the dropdown deterministic and still uses the
    shared GraphQL fetcher/session path.
   */
  useEffect(() => {
    setActiveIndex((prev) => {
      if (options.length === 0) return 0;
      return Math.min(prev, options.length - 1);
    });
  }, [options.length]);

  const selected = useMemo(
    () => options.find((o) => o.id === props.value) ?? null,
    [options, props.value],
  );

  const placeholder =
    props.placeholder ?? i18n.t("admin.domainPicker.user.placeholder");

  const commitSelection = useCallback(
    (option: UserOption) => {
      props.onChange(option.id);
      setQuery(option.email);
      setOpen(false);
    },
    [props],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (props.disabled) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setOpen(true);
        setActiveIndex((i) => Math.min(i + 1, Math.max(options.length - 1, 0)));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setOpen(true);
        setActiveIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        setActiveIndex(0);
        return;
      }
      if (event.key === "End") {
        event.preventDefault();
        setActiveIndex(Math.max(options.length - 1, 0));
        return;
      }
      if (event.key === "Enter") {
        if (!open || options.length === 0) return;
        event.preventDefault();
        const target = options[activeIndex];
        if (target) commitSelection(target);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      }
    },
    [props.disabled, options, open, activeIndex, commitSelection],
  );

  const optionId = (idx: number) => `${listboxId}-opt-${idx}`;
  const state = !shouldFetch
    ? {
        kind: "idle" as const,
        label: i18n.t("admin.domainPicker.user.placeholder"),
        testId: "user-picker-idle",
      }
    : isLoading
      ? {
          kind: "loading" as const,
          label: i18n.t("admin.state.loading"),
          testId: "user-picker-loading",
        }
      : error
        ? {
            kind: "error" as const,
            label: i18n.t("admin.state.error"),
            testId: "user-picker-error",
          }
        : options.length === 0
          ? {
              kind: "empty" as const,
              label: i18n.t("admin.state.no-results"),
              testId: "user-picker-empty",
            }
          : { kind: "options" as const };

  const comboboxOptions = options.map((option, idx) => {
    const isActive = idx === activeIndex;
    const isSelected = selected?.id === option.id;
    return {
      id: optionId(idx),
      value: option.id,
      title: option.name || option.email,
      meta: option.email,
      active: isActive,
      selected: isSelected,
      leading: (
        <Avatar
          name={monogramFromEmail(option.email)}
          size={32}
          colorfulFallback
        />
      ),
      trailing:
        props.mode === "admin" ? (
          <>
            {option.isAdmin ? <StatusDot tone="warning" label="admin" /> : null}
            {option.features?.includes("manager") ? (
              <StatusDot tone="info" label="manager" />
            ) : null}
          </>
        ) : null,
    };
  });

  return (
    <SearchCombobox
      label={props.label}
      aria-label={props.label}
      value={query}
      placeholder={placeholder}
      disabled={props.disabled}
      isOpen={open}
      inputId={inputId}
      listboxId={listboxId}
      activeDescendant={
        open && options.length > 0 ? optionId(activeIndex) : undefined
      }
      state={state}
      options={comboboxOptions}
      data-testid={props["data-testid"]}
      onInputChange={(next) => {
        setQuery(next);
        setOpen(true);
        if (props.value !== null) {
          props.onChange(null);
        }
      }}
      onInputFocus={() => setOpen(true)}
      onInputKeyDown={handleKeyDown}
      onOptionHover={setActiveIndex}
      onOptionCommit={(facadeOption) => {
        const target = options.find(
          (candidate) => candidate.id === facadeOption.value,
        );
        if (target) commitSelection(target);
      }}
      onClose={() => setOpen(false)}
    />
  );
}
