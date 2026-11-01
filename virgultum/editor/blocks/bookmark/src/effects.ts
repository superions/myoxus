import { BookmarkBlockComponent } from "./bookmark-block";
import { BookmarkEdgelessBlockComponent } from "./bookmark-edgeless-block";
import { BookmarkCard } from "./components/bookmark-card";

export function effects() {
  customElements.define(
    "myoxus-edgeless-bookmark",
    BookmarkEdgelessBlockComponent,
  );
  customElements.define("myoxus-bookmark", BookmarkBlockComponent);
  customElements.define("bookmark-card", BookmarkCard);
}
