#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# `scope-guard.sh` - B-FIND-05 followup (P-VIRG-ARCH-B-09).
#
# Verhindert versehentliche Repository-weite vitest-Runs ohne
# Pfad-Filter. In einer Monorepo mit drei unterschiedlichen
# Vitest-Projekten (root frontend-unit, virgultum/std, virgultum/store,
# virgultum/sync, virgultum/global, virgultum/integration-test) fuehrt
# ein unqualifiziertes `vitest run` zu zwei Problemen:
#
#   1. Vitest nimmt das erste gefundene Projekt (root
#      frontend-unit) und ignoriert die Virgultum-Specs -
#      Tester denkt, er hat gruen, hat aber nur 10% geprueft.
#   2. Falls mehrere Configs im selben Lauf entdeckt werden,
#      bricht der Lauf an Specs, die fuer andere Environments
#      gedacht sind (Mermaid-Warnings im happy-DOM-Setup,
#      Storage-Snapshot-Drift im Vitest-Browser-Setup).
#
# Usage: scope-guard.sh <command...>
#        command = der vollstaendige vitest- oder
#                  Workspace-Test-Befehl, der ausgefuehrt
#                  werden soll.
#
# Beispiel:
#   ./build/scripts/test/scope-guard.sh yarn vitest run virgultum/framework/std
#   ./build/scripts/test/scope-guard.sh yarn workspace @virgultum/std test
#
# Exit-Codes:
#   0 - Befehl enthaelt einen Pfad-Filter oder ein
#       explizites --project und ist erlaubt.
#   2 - Befehl fehlt der Pfad-Filter; Abbruch.
#
# Designprinzip: Allow-List, nicht Deny-List. Wir blocken
# nur das offensichtlich falsche Muster (nacktes `vitest
# run` ohne Argumente), nicht legitime Diagnose-Laeufe.

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <command...>" >&2
  exit 64
fi

joined="$*"

# Heuristik 1: nackter `vitest run` ohne Argumente.
# Erlaubt ist z.B. `vitest run virgultum/...` oder
# `vitest --run --project virgultum-std`.
if [[ "$joined" =~ (^|[[:space:]])vitest[[:space:]]+(run|--run)([[:space:]]+--?[a-z][a-zA-Z0-9-]+)*[[:space:]]*$ ]]; then
  echo "scope-guard: refusing repo-wide vitest run" >&2
  echo "  hint: add a path filter (e.g. 'virgultum/framework/std')" >&2
  echo "  hint: or pass --project <name>" >&2
  echo "  hint: or run via 'yarn workspace <pkg> test' to scope to a single package" >&2
  exit 2
fi

# Heuristik 2: `yarn test` ohne Pfad-Argument. Das
# wuerde via package.json `test`-Skript das root
# frontend-unit-Projekt aufrufen, was bei cross-cutting
# Phasen (E, F, G, H) zu false-green fuehrt.
if [[ "$joined" =~ (^|[[:space:]])yarn[[:space:]]+test([[:space:]]+--?[a-z][a-zA-Z0-9-]+)*[[:space:]]*$ ]]; then
  echo "scope-guard: refusing repo-wide 'yarn test' run" >&2
  echo "  hint: use 'yarn vitest run <path>'" >&2
  echo "  hint: or 'yarn workspace <pkg> test'" >&2
  exit 2
fi

exec "$@"
