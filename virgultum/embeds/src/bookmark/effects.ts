import { BookmarkBlockComponent } from "./bookmark-block";
import { BookmarkEdgelessBlockComponent } from "./bookmark-edgeless-block";

export function effects() {
  customElements.define(
    "myoxus-edgeless-bookmark",
    BookmarkEdgelessBlockComponent,
  );
  customElements.define("myoxus-bookmark", BookmarkBlockComponent);
}
