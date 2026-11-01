// SPDX-License-Identifier: AGPL-3.0-or-later
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const nativeBinding = require("./native-binding.cjs");

export const DocStorage = nativeBinding.DocStorage;
export const DocStoragePool = nativeBinding.DocStoragePool;

export default nativeBinding;
