// SPDX-License-Identifier: AGPL-3.0-or-later

export type DatabaseViewPrimaryAction = {
  disabled?: boolean;
  disabledReason?: string;
  label: string;
  onSelect: () => void;
};
