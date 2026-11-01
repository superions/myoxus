// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  UserPreferencesService,
  type Server,
} from "@myoxus/core/modules/server";
import {
  type AssistantContext,
  type AssistantPackageFragmentFragment,
  type ResolvedSavedAssistantSelectionFragmentFragment,
  type ResolveSavedAssistantSetupQuery,
  type SavedSetupConfigurationFragmentFragment,
  type SaveAssistantSetupInput,
} from "@myoxus/graphql";
import { useLiveData } from "@myoxus/infra";
import { useCallback, useEffect, useRef, useState } from "react";
import { visibleAssistantAnswers } from "./values";

export type SavedSetupResolution = NonNullable<
  NonNullable<
    ResolveSavedAssistantSetupQuery["currentUser"]
  >["resolveSavedAssistantSetup"]
>;

export function savedSetupDescriptor(
  packages: readonly AssistantPackageFragmentFragment[],
  selection: ResolvedSavedAssistantSelectionFragmentFragment,
) {
  const identity = selection.descriptor?.identity;
  return (
    identity &&
    packages.find(
      (source) =>
        source.identity.id === identity.id &&
        source.identity.version === identity.version &&
        source.identity.digest === identity.digest,
    )
  );
}

/** Only untouched inputs receive current defaults. Cleared values stay empty;
 * an explicit native false for a new component remains an explicit answer. */
export function savedSetupAnswers(
  source: AssistantPackageFragmentFragment,
  selection: ResolvedSavedAssistantSelectionFragmentFragment,
) {
  const answers = { ...visibleAssistantAnswers(source, {}, true) };
  for (const { input, value } of selection.defaults) answers[input] = value;
  for (const cleared of selection.cleared) {
    if (
      cleared.inputId &&
      !selection.defaults.some((entry) => entry.input === cleared.inputId)
    )
      delete answers[cleared.inputId];
  }
  return visibleAssistantAnswers(source, answers);
}

/** Ephemeral UI state only. The existing preference service owns online ACKs;
 * loading never saves a preference or confirms a business operation. */
export function useSavedSetup(
  server: Server | undefined,
  context: AssistantContext,
  disabled: boolean,
) {
  const actor = useLiveData(server?.account$)?.id;
  const service = server?.scope.get(UserPreferencesService);
  const [entries, setEntries] = useState<
    SavedSetupConfigurationFragmentFragment[]
  >([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [cleared, setCleared] = useState(false);
  const [authRevision, setAuthRevision] = useState(0);
  const epoch = useRef(0);
  const flight = useRef(false);
  const saveId = useRef<string | undefined>(undefined);
  const scope = JSON.stringify([server?.id, actor, context, authRevision]);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  useEffect(() => {
    const subscription = server?.account$.subscribe((value) => {
      if (value?.id !== actor) {
        ++epoch.current;
        setAuthRevision((value) => value + 1);
      }
    });
    return () => {
      ++epoch.current;
      subscription?.unsubscribe();
    };
  }, [server, actor]);
  const current = useCallback(
    (generation: number, owner: string) =>
      generation === epoch.current &&
      scopeRef.current === owner &&
      server?.account$.value?.id === actor,
    [server, actor],
  );
  useEffect(() => {
    const generation = ++epoch.current;
    setEntries([]);
    setSelectedId(null);
    setLabel("");
    setUnavailable(false);
    setCleared(false);
    saveId.current = undefined;
    flight.current = false;
    setBusy(false);
    setFailed(false);
    if (service && actor) {
      setBusy(true);
      void service
        .getSavedSetups()
        .then(
          (values) => {
            if (current(generation, scope)) setEntries(values);
          },
          () => {
            if (current(generation, scope)) setFailed(true);
          },
        )
        .finally(() => {
          if (current(generation, scope)) setBusy(false);
        });
    }
    return () => {
      ++epoch.current;
    };
  }, [service, actor, scope, current]);
  const run = async (
    operation: (generation: number, owner: string) => Promise<void>,
  ) => {
    if (
      !service ||
      !actor ||
      server?.account$.value?.id !== actor ||
      disabledRef.current ||
      flight.current ||
      busy
    )
      return;
    const generation = ++epoch.current;
    flight.current = true;
    setBusy(true);
    setFailed(false);
    try {
      await operation(generation, scope);
    } catch {
      if (current(generation, scope)) setFailed(true);
    } finally {
      if (current(generation, scope)) {
        flight.current = false;
        setBusy(false);
      }
    }
  };
  const clear = () => {
    if (busy || disabledRef.current) return;
    setSelectedId(null);
    setLabel("");
    setUnavailable(false);
    setCleared(false);
    saveId.current = undefined;
  };
  return {
    options: entries
      .filter((entry) => entry.context === context)
      .map(({ id, name }) => ({ id, label: name })),
    selectedId,
    label,
    busy,
    failed,
    unavailable,
    cleared,
    onSelect: (id: string) => {
      if (busy || disabledRef.current) return;
      setSelectedId(id);
      setLabel(entries.find((entry) => entry.id === id)?.name ?? "");
      saveId.current = id;
      setUnavailable(false);
      setCleared(false);
    },
    onLabelChange: (value: string) => {
      if (!busy && !disabledRef.current) setLabel(value);
    },
    onClear: clear,
    onRetry: () =>
      void run(async (generation, owner) => {
        const values = await service!.getSavedSetups();
        if (current(generation, owner)) setEntries(values);
      }),
    onDelete: () =>
      void run(async (generation, owner) => {
        if (!selectedId) return;
        const values = await service!.deleteSetup(selectedId);
        if (!current(generation, owner)) return;
        setEntries(values);
        setSelectedId(null);
        setLabel("");
        setUnavailable(false);
        setCleared(false);
        saveId.current = undefined;
      }),
    save: (capture: Omit<SaveAssistantSetupInput, "id" | "name" | "context">) =>
      void run(async (generation, owner) => {
        const id = (saveId.current ??= crypto.randomUUID());
        const values = await service!.saveSetup({
          ...capture,
          id,
          name: label,
          context,
        });
        if (!current(generation, owner)) return;
        setEntries(values);
        setSelectedId(id);
        setUnavailable(false);
        setCleared(false);
      }),
    load: (
      apply: (resolution: SavedSetupResolution) => boolean | Promise<boolean>,
    ) =>
      void run(async (generation, owner) => {
        if (!selectedId) return;
        const resolution = await service!.resolveSetup(selectedId);
        if (!current(generation, owner) || disabledRef.current) return;
        if (!resolution || resolution.unavailable) {
          setUnavailable(true);
          return;
        }
        const accepted = await apply(resolution);
        if (!current(generation, owner)) return;
        setUnavailable(!accepted);
        setCleared(
          [resolution.package, resolution.project, resolution.setup].some(
            (selection) => Boolean(selection?.cleared.length),
          ),
        );
      }),
  };
}
