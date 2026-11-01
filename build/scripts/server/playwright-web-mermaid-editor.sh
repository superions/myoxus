#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

# Focused Mermaid Page family journey. This served gate owns the existing Page
# journey extended by each structured family phase.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# A changed family can reuse the other families' valid served evidence. The
# default keeps the complete existing family selection; only known owners may
# narrow a causal rerun.
family="${MYOXUS_MERMAID_FAMILY:-}"
pie_title="Mermaid Pie restores text and chart in Edgeless and survives reload"
grep="Mermaid $family keeps"
case "$family" in
  Flowchart)
    exec "$SCRIPT_DIR/playwright-web-editor-flow.sh" \
      tests/client/webfrontend/editor-flow/tests/virgultum-mermaid-block-flowchart-gfx-editing.spec.ts "$@"
    ;;
  Architecture)
    exec "$SCRIPT_DIR/playwright-web-editor-flow.sh" \
      tests/client/webfrontend/editor-flow/tests/virgultum-mermaid-block-architecture.spec.ts "$@"
    ;;
  "")
    family="(Pie|Radar|Treemap|XY|Gantt|Timeline|Kanban|Journey|Packet|Class|ER|Sequence|State|Block|C4|GitGraph|Mindmap|Requirement)"
    grep="Mermaid $family keeps|$pie_title"
    ;;
  Pie) grep="$pie_title" ;;
  Quadrant|Radar|Treemap|XY|Gantt|Timeline|Kanban|Journey|Packet|Class|ER|Sequence|State|Block|C4|GitGraph|Mindmap|Requirement) ;;
  *) echo "Unsupported Mermaid family: $family" >&2; exit 2 ;;
esac
exec "$SCRIPT_DIR/playwright-web-editor-flow.sh" \
  tests/client/webfrontend/editor-flow/tests/virgultum-mermaid-block-page-mermaid.spec.ts \
  --grep "$grep" \
  "$@"
