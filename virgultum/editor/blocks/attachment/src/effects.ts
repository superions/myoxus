import { AttachmentBlockComponent } from "./attachment-block";
import { AttachmentEdgelessBlockComponent } from "./attachment-edgeless-block";

export function effects() {
  customElements.define(
    "myoxus-edgeless-attachment",
    AttachmentEdgelessBlockComponent,
  );
  customElements.define("myoxus-attachment", AttachmentBlockComponent);
}
