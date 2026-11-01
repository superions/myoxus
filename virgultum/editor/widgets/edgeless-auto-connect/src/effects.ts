import {
  EdgelessAutoConnectWidget,
  MYOXUS_EDGELESS_AUTO_CONNECT_WIDGET,
} from ".";

export function effects() {
  customElements.define(
    MYOXUS_EDGELESS_AUTO_CONNECT_WIDGET,
    EdgelessAutoConnectWidget,
  );
}
