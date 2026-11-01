/**
 * Admin domain picker — OuPicker (P-AR-0-02).
 *
 * Server-search combobox for organization units. Renders an input that
 * fires `searchOrganizationUnits` against the GraphQL API after a 200ms
 * debounce, and exposes a Facade SearchCombobox dropdown with
 * keyboard navigation, A11y attributes, loading/empty/error states and
 * the shared Facade SearchCombobox surface.
 *
 * Design choices:
 *   - Uses the shared GraphQL fetcher directly from a debounced effect. This
 *     matches UserPicker/WorkspacePicker and avoids the old SWR null-key path
 *     that could render "no results" without issuing the search request.
 *   - Skip mechanism: if `query.length < 1` the effect clears local options
 *     and no request is issued.
 *   - Selection persists across queries: when `value` is set the
 *     trigger shows the last selected unit's display name. Hitting the
 *     input clears the visible label and starts a new search.
 *   - Visual chrome is owned by the shared Facade SearchCombobox. This picker
 *     owns only the server search and option mapping.
 *
 * No business logic beyond the picker: callers are responsible for
 * persisting `value` and any side effects when the selection changes.
 */
import { searchOrganizationUnitsQuery } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { SearchCombobox } from "@myoxus/ui-facade";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useState,
} from "react";

import { gqlFetcher } from "../../use-query";

interface OuPickerProps {
  /** Currently selected unit-id or null when nothing is picked. */
  value: string | null;
  /** Called when the user picks a unit (id) or clears the picker (null). */
  onChange: (id: string | null) => void;
  /**
   * Optional override for the placeholder. Callers must pass an
   * already-translated string — the component falls back to the
   * `admin.domainPicker.ou.placeholder` i18n key when omitted.
   */
  placeholder?: string;
  label?: string;
  /**
   * Display label for an already-selected id. The picker intentionally owns no
   * entity cache; callers that already have the OU row can provide the label so
   * edit forms do not show an empty input for persisted parent ids.
   */
  displayValue?: string | null;
  disabled?: boolean;
  "data-testid"?: string;
}

interface OuOption {
  id: string;
  name: string;
  slug: string;
  parentBreadcrumb: string[];
}

/**
 * Modulo helper that handles negative results so ArrowUp from the
 * first item wraps to the last.
 */
function wrapIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return ((index % length) + length) % length;
}

export function OuPicker({
  value,
  onChange,
  placeholder,
  label,
  displayValue,
  disabled,
  "data-testid": dataTestId,
}: OuPickerProps) {
  const i18n = useI18n();
  const listboxId = useId();
  const optionIdPrefix = useId();

  const [query, setQuery] = useState<string>("");
  const [debouncedQuery, setDebouncedQuery] = useState<string>("");
  const [isOpen, setIsOpen] = useState<boolean>(false);
  const [highlightedIndex, setHighlightedIndex] = useState<number>(0);
  const [selectedLabel, setSelectedLabel] = useState<string | null>(null);
  const [options, setOptions] = useState<OuOption[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // The picker has no entity cache. Edit forms that already know the
  // selected OU can provide `displayValue`; otherwise we only keep labels
  // selected through this component.
  useEffect(() => {
    if (value === null) {
      setSelectedLabel(null);
      return;
    }
    if (displayValue) {
      setSelectedLabel(displayValue);
    }
  }, [value, displayValue]);

  // Debounce the query input by 200ms before firing the GraphQL request.
  useEffect(() => {
    const handle = setTimeout(() => {
      setDebouncedQuery(query);
    }, 200);
    return () => clearTimeout(handle);
  }, [query]);

  useEffect(() => {
    if (debouncedQuery.length < 1) {
      setOptions([]);
      setIsLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setError(null);

    gqlFetcher({
      query: searchOrganizationUnitsQuery,
      variables: { query: debouncedQuery, limit: 50 },
    })
      .then((data) => {
        if (cancelled) return;
        setOptions((data.searchOrganizationUnits ?? []) as OuOption[]);
      })
      .catch((cause) => {
        if (cancelled) return;
        console.warn("OuPicker search failed", {
          query: debouncedQuery,
          cause,
        });
        setError(cause);
        setOptions([]);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [debouncedQuery]);

  // Reset highlight when option list shrinks below the cursor.
  useEffect(() => {
    if (highlightedIndex >= options.length) {
      setHighlightedIndex(0);
    }
  }, [options.length, highlightedIndex]);

  const commitSelection = useCallback(
    (option: OuOption) => {
      onChange(option.id);
      setSelectedLabel(option.name);
      setQuery("");
      setDebouncedQuery("");
      setIsOpen(false);
      setHighlightedIndex(0);
    },
    [onChange],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setIsOpen(false);
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setIsOpen(true);
        setHighlightedIndex((prev) => wrapIndex(prev + 1, options.length));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setIsOpen(true);
        setHighlightedIndex((prev) => wrapIndex(prev - 1, options.length));
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        setIsOpen(true);
        setHighlightedIndex(0);
        return;
      }
      if (event.key === "End") {
        event.preventDefault();
        setIsOpen(true);
        if (options.length > 0) {
          setHighlightedIndex(options.length - 1);
        }
        return;
      }
      if (event.key === "Enter") {
        if (options.length === 0) return;
        const target = options[wrapIndex(highlightedIndex, options.length)];
        if (target) {
          event.preventDefault();
          commitSelection(target);
        }
      }
    },
    [options, highlightedIndex, commitSelection],
  );

  const inputValue = isOpen || query.length > 0 ? query : (selectedLabel ?? "");

  const showLoading = debouncedQuery.length >= 1 && isLoading;
  const showError = !!error && debouncedQuery.length >= 1;
  const showEmpty =
    !showLoading &&
    !showError &&
    debouncedQuery.length >= 1 &&
    options.length === 0;
  const showOptions =
    !showLoading &&
    !showError &&
    debouncedQuery.length >= 1 &&
    options.length > 0;

  const resolvedPlaceholder =
    placeholder ?? i18n.t("admin.domainPicker.ou.placeholder");

  const comboboxOptions = showOptions
    ? options.map((option, idx) => {
        const isHighlighted =
          idx === wrapIndex(highlightedIndex, options.length);
        const breadcrumb = option.parentBreadcrumb ?? [];
        return {
          id: `${optionIdPrefix}-${idx}`,
          value: option.id,
          title: option.name,
          meta:
            breadcrumb.length > 0
              ? breadcrumb.map((p) => `> ${p}`).join(" ")
              : undefined,
          code: option.slug,
          active: isHighlighted,
          selected: isHighlighted,
          testId: `ou-picker-option-${idx}`,
        };
      })
    : [];

  return (
    <SearchCombobox
      label={label}
      value={inputValue}
      placeholder={resolvedPlaceholder}
      disabled={disabled}
      isOpen={isOpen}
      listboxId={listboxId}
      activeDescendant={
        isOpen && options.length > 0
          ? `${optionIdPrefix}-${wrapIndex(highlightedIndex, options.length)}`
          : undefined
      }
      state={
        showLoading
          ? { kind: "loading", label: i18n.t("admin.state.loading") }
          : showError
            ? { kind: "error", label: i18n.t("admin.state.error") }
            : showEmpty
              ? { kind: "empty", label: i18n.t("admin.state.no-results") }
              : { kind: "options" }
      }
      options={comboboxOptions}
      data-testid={dataTestId}
      onInputChange={(next) => {
        setQuery(next);
        setIsOpen(true);
        setHighlightedIndex(0);
        if (next.length === 0) {
          // The parent decides whether typing-to-empty clears persisted value.
          setSelectedLabel(null);
        }
      }}
      onInputFocus={() => setIsOpen(true)}
      onInputKeyDown={handleKeyDown}
      onOptionHover={setHighlightedIndex}
      onOptionCommit={(option) => {
        const target = options.find(
          (candidate) => candidate.id === option.value,
        );
        if (target) commitSelection(target);
      }}
      onClose={() => setIsOpen(false)}
    />
  );
}
