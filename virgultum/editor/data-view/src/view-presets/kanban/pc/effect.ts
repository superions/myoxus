import { KanbanCard } from "./card.js";
import { KanbanCell } from "./cell.js";
import { KanbanGroup } from "./group.js";
import { KanbanHeader } from "./header.js";

export function pcEffects() {
  customElements.define("myoxus-data-view-kanban-card", KanbanCard);
  customElements.define("myoxus-data-view-kanban-cell", KanbanCell);
  customElements.define("myoxus-data-view-kanban-group", KanbanGroup);
  customElements.define("myoxus-data-view-kanban-header", KanbanHeader);
}
