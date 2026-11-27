import {
  type EdgelessConnectorHandle,
  registerEdgelessConnectorHandle,
} from "./components/native-connector-handle";
import { EdgelessConnectorLabelEditor } from "./text/edgeless-connector-label-editor";

export function effects() {
  customElements.define(
    "edgeless-connector-label-editor",
    EdgelessConnectorLabelEditor,
  );
  registerEdgelessConnectorHandle();
}

declare global {
  interface HTMLElementTagNameMap {
    "edgeless-connector-label-editor": EdgelessConnectorLabelEditor;
    "edgeless-connector-handle": EdgelessConnectorHandle;
  }
}
