// SPDX-License-Identifier: MIT

import { createContext } from "react";

import type { DNDData, fromExternalData, toExternalData } from "./types";

export const DNDContext = createContext<{
  /**
   * external data adapter.
   * Convert external drag payloads to the Myoxus drag data used by consumers.
   *
   * if this is provided, the drop target will handle external elements as well.
   *
   * @default undefined
   */
  fromExternalData?: fromExternalData<DNDData>;

  /**
   * Convert the draggable data to the external data.
   * Mainly used to be consumed by virgultum.
   *
   * @default undefined
   */
  toExternalData?: toExternalData<DNDData>;
}>({});
