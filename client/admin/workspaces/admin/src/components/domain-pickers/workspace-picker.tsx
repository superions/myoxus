/**
 * Admin domain picker — WorkspacePicker (P-AR-0-04).
 *
 * Server-search combobox for workspaces. Renders an input that fires
 * `adminSearchWorkspaces` against the GraphQL API after a 200ms
 * debounce, and exposes a Facade SearchCombobox dropdown with
 * keyboard navigation, A11y attributes, loading/empty/error states,
 * and the shared Facade SearchCombobox surface.
 *
 * Each option displays:
 *   - Workspace name (display text)
 *   - Owner e-mail in a mono small line, falling back to `ownerUserId`
 *     when the server returns null.
 *   - StatusDot showing OU-link state ("OU-linked" or "standalone").
 *
 * Optional `ouId` prop scopes the search to workspaces linked to a
 * specific organization unit. Optional `excludeUnitId` removes workspaces
 * already linked to a unit and is used by add flows to prevent duplicate
 * OU↔workspace links at the server boundary. Only one of both filters should
 * be passed.
 *
 * Design choices mirror OuPicker:
 *   - Suspense disabled on the underlying useQuery so we render the
 *     loading state inline instead of suspending the parent tree on
 *     every keystroke.
 *   - Skip mechanism: if the debounced query length is 0 we pass
 *     `undefined` to useQuery — `use-query.ts` returns a null SWR key
 *     in that case, so no fetch is issued.
 *   - Visual chrome is owned by the shared Facade SearchCombobox. This picker
 *     owns only the server search and option mapping.
 */
import { adminSearchWorkspacesQuery } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { SearchCombobox, StatusDot } from "@myoxus/ui-facade";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useState,
} from "react";

import { gqlFetcher } from "../../use-query";

export interface WorkspacePickerProps {
  /** Currently selected workspace-id or null when nothing is picked. */
  value: string | null;
  /** Called when the user picks a workspace (id) or clears it (null). */
  onChange: (id: string | null) => void;
  /**
   * Optional filter: only workspaces linked to this OU are returned.
   * Forwarded verbatim to `adminSearchWorkspaces.ouId`.
   */
  ouId?: string;
  /**
   * Optional anti-duplicate filter: workspaces already linked to this OU are
   * excluded server-side. Forwarded to `adminSearchWorkspaces.excludeUnitId`.
   */
  excludeUnitId?: string;
  /**
   * Optional placeholder override. Callers must pass an
   * already-translated string — falls back to the
   * `admin.domainPicker.workspace.placeholder` i18n key.
   */
  placeholder?: string;
  label?: string;
  disabled?: boolean;
  "data-testid"?: string;
}

interface WorkspaceOption {
  id: string;
  name: string;
  ownerUserId: string | null;
  ownerEmail: string | null;
  linkedOuIds: ReadonlyArray<string>;
}

/**
 * Modulo helper that handles negative results so ArrowUp from the
 * first item wraps to the last.
 */
function wrapIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return ((index % length) + length) % length;
}

export function WorkspacePicker({
  value,
  onChange,
  ouId,
  excludeUnitId,
  placeholder,
  label,
  disabled,
  "data-testid": dataTestId,
}: WorkspacePickerProps) {
  const i18n = useI18n();
  const listboxId = useId();
  const optionIdPrefix = useId();

  const [query, setQuery] = useState<string>("");
  const [debouncedQuery, setDebouncedQuery] = useState<string>("");
  const [isOpen, setIsOpen] = useState<boolean>(false);
  const [highlightedIndex, setHighlightedIndex] = useState<number>(0);
  const [selectedLabel, setSelectedLabel] = useState<string | null>(null);
  const [options, setOptions] = useState<WorkspaceOption[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // Debounce the query input by 200ms before firing the GraphQL request.
  useEffect(() => {
    const handle = setTimeout(() => {
      setDebouncedQuery(query);
    }, 200);
    return () => clearTimeout(handle);
  }, [query]);

  // When the parent clears `value` (e.g. via a Reset button) we drop the
  // displayed label so the input goes back to its placeholder.
  useEffect(() => {
    if (value === null) {
      setSelectedLabel(null);
    }
  }, [value]);

  useEffect(() => {
    // Invalidate the previous search immediately, before the debounce settles.
    // Old hits must not remain selectable under a different visible query.
    if (query !== debouncedQuery) {
      setOptions([]);
      setError(null);
      setIsLoading(query.length > 0);
      return;
    }
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
      query: adminSearchWorkspacesQuery,
      variables: {
        query: debouncedQuery,
        ouId: ouId ?? null,
        excludeUnitId: excludeUnitId ?? null,
        limit: 50,
      },
    })
      .then((data) => {
        if (cancelled) return;
        setOptions(
          (data.admin?.adminSearchWorkspaces ?? []) as WorkspaceOption[],
        );
      })
      .catch((cause) => {
        if (cancelled) return;
        console.warn("WorkspacePicker search failed", {
          query: debouncedQuery,
          ouId,
          excludeUnitId,
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
  }, [query, debouncedQuery, excludeUnitId, ouId]);

  // Reset highlight when option list shrinks below the cursor.
  useEffect(() => {
    if (highlightedIndex >= options.length) {
      setHighlightedIndex(0);
    }
  }, [options.length, highlightedIndex]);

  const commitSelection = useCallback(
    (option: WorkspaceOption) => {
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
      if (event.key === "Escape" && isOpen) {
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
    [options, highlightedIndex, commitSelection, isOpen],
  );

  const inputValue = isOpen || query.length > 0 ? query : (selectedLabel ?? "");

  const searchSettled = query === debouncedQuery;
  const showLoading = query.length >= 1 && isLoading;
  const showError = searchSettled && !!error && query.length >= 1;
  const showEmpty =
    !showLoading &&
    !showError &&
    searchSettled &&
    query.length >= 1 &&
    options.length === 0;
  const showOptions =
    !showLoading &&
    !showError &&
    searchSettled &&
    query.length >= 1 &&
    options.length > 0;

  const resolvedPlaceholder =
    placeholder ?? i18n.t("admin.domainPicker.workspace.placeholder");

  const comboboxOptions = showOptions
    ? options.map((option, idx) => {
        const isHighlighted =
          idx === wrapIndex(highlightedIndex, options.length);
        const linked = option.linkedOuIds.length > 0;
        const ownerLabel = option.ownerEmail ?? option.ownerUserId ?? "";
        return {
          id: `${optionIdPrefix}-${idx}`,
          value: option.id,
          title: option.name,
          meta: ownerLabel || undefined,
          active: isHighlighted,
          selected: isHighlighted,
          testId: `workspace-picker-option-${idx}`,
          trailing: (
            <StatusDot
              tone={linked ? "info" : "neutral"}
              label={
                linked
                  ? i18n.t("admin.domainPicker.workspace.ou-linked")
                  : i18n.t("admin.domainPicker.workspace.standalone")
              }
            />
          ),
        };
      })
    : [];

  return (
    <SearchCombobox
      value={inputValue}
      placeholder={resolvedPlaceholder}
      label={label}
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
        // Editing a committed label invalidates its ID; consumers must not
        // continue reading or submitting the previously selected workspace.
        if (value !== null) onChange(null);
        setQuery(next);
        setIsOpen(true);
        setHighlightedIndex(0);
        if (next.length === 0) {
          setSelectedLabel(null);
        }
      }}
      onInputFocus={() => setIsOpen(true)}
      onInputKeyDown={handleKeyDown}
      onOptionHover={setHighlightedIndex}
      onOptionCommit={(facadeOption) => {
        const target = options.find(
          (candidate) => candidate.id === facadeOption.value,
        );
        if (target) commitSelection(target);
      }}
      onClose={() => setIsOpen(false)}
    />
  );
}
