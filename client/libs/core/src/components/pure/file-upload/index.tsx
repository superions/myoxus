// SPDX-FileCopyrightText: 2022-2026 TOEVERYTHING PTE. LTD. and its affiliates.
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: MIT

import { useI18n } from "@myoxus/i18n";
import { Box, Button, FileButton } from "@myoxus/ui-facade";
import {
  type InputHTMLAttributes,
  type PropsWithChildren,
  useRef,
} from "react";

export interface UploadProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "onChange" | "type" | "accept" | "disabled"
> {
  uploadType?: string;
  accept?: string;
  fileChange: (file: File) => void;
  disabled?: boolean;
}

export const Upload = ({
  fileChange,
  accept,
  children,
  disabled,
  uploadType: _uploadType,
  ...inputProps
}: PropsWithChildren<UploadProps>) => {
  const t = useI18n();
  const resetRef = useRef<() => void>(null);

  if (disabled) {
    return children ?? <Button disabled>{t["Upload"]()}</Button>;
  }

  return (
    <FileButton
      accept={accept}
      inputProps={inputProps}
      resetRef={resetRef}
      onChange={(file) => {
        if (file) {
          fileChange(file);
        }
        resetRef.current?.();
      }}
    >
      {({ onClick }) =>
        children ? (
          <Box display="inline-flex" onClick={onClick}>
            {children}
          </Box>
        ) : (
          <Button onClick={onClick}>{t["Upload"]()}</Button>
        )
      }
    </FileButton>
  );
};
