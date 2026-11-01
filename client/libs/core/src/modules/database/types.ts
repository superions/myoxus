// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  DatabaseCellValueFragment,
  DatabaseFieldFragment,
  DatabaseRecordFragment,
  DatabaseRowRecordFragment,
  DatabaseRowTemplateBindingFragment,
  DatabaseViewFragment,
} from "@myoxus/graphql";

export type DatabaseRecord = DatabaseRecordFragment;
export type DatabaseField = DatabaseFieldFragment;
export type DatabaseView = DatabaseViewFragment;
export type DatabaseRowRecord = DatabaseRowRecordFragment;
export type DatabaseCellValue = DatabaseCellValueFragment;
export type DatabaseRowTemplateBinding = DatabaseRowTemplateBindingFragment;
