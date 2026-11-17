import { EmbedLinkedDocBlockComponent } from "./embed-linked-doc-block";
import { EmbedEdgelessLinkedDocBlockComponent } from "./embed-linked-doc-block/embed-edgeless-linked-doc-block";
import { EmbedSyncedDocBlockComponent } from "./embed-synced-doc-block";
import { EmbedSyncedDocCard } from "./embed-synced-doc-block/components/embed-synced-doc-card";
import { EmbedEdgelessSyncedDocBlockComponent } from "./embed-synced-doc-block/embed-edgeless-synced-doc-block";

export function effects() {
  customElements.define("myoxus-embed-synced-doc-card", EmbedSyncedDocCard);

  customElements.define(
    "myoxus-embed-edgeless-linked-doc-block",
    EmbedEdgelessLinkedDocBlockComponent,
  );
  customElements.define(
    "myoxus-embed-linked-doc-block",
    EmbedLinkedDocBlockComponent,
  );

  customElements.define(
    "myoxus-embed-edgeless-synced-doc-block",
    EmbedEdgelessSyncedDocBlockComponent,
  );
  customElements.define(
    "myoxus-embed-synced-doc-block",
    EmbedSyncedDocBlockComponent,
  );
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-embed-synced-doc-card": EmbedSyncedDocCard;
    "myoxus-embed-synced-doc-block": EmbedSyncedDocBlockComponent;
    "myoxus-embed-edgeless-synced-doc-block": EmbedEdgelessSyncedDocBlockComponent;
    "myoxus-embed-linked-doc-block": EmbedLinkedDocBlockComponent;
    "myoxus-embed-edgeless-linked-doc-block": EmbedEdgelessLinkedDocBlockComponent;
  }
}
