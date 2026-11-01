import { useI18n } from "@myoxus/i18n";
import { Button, Group, MyoxusText, RowInput, Stack } from "@myoxus/ui-facade";
import { useCallback, useState } from "react";

import type { RenameContentProps } from "./type";

export const RenameContent = ({
  initialName = "",
  inputProps,
  confirmButtonProps,
  inputPrefixRenderer: InputPrefixRenderer,
  inputBelowRenderer: InputBelowRenderer,
  descRenderer: DescRenderer,
  confirmText = "Done",
  onConfirm,
}: RenameContentProps) => {
  const t = useI18n();
  const [value, setValue] = useState(initialName);

  const handleDone = useCallback(() => {
    onConfirm?.(value);
  }, [onConfirm, value]);

  const description = DescRenderer ? (
    <DescRenderer input={value} />
  ) : (
    t["com.myoxus.m.rename-to"]({ name: value })
  );

  return (
    <Stack data-myoxus-ui-role="mobile-rename-content" p="sm">
      <Stack data-myoxus-ui-role="mobile-rename-field" gap="sm">
        <Group
          data-myoxus-ui-role="mobile-rename-input-row"
          gap="sm"
          miw={0}
          wrap="nowrap"
        >
          {InputPrefixRenderer ? <InputPrefixRenderer input={value} /> : null}
          <RowInput
            autoFocus
            block
            size="extraLarge"
            value={value}
            onChange={setValue}
            data-testid="rename-input"
            {...inputProps}
          />
        </Group>
        {InputBelowRenderer ? <InputBelowRenderer input={value} /> : null}
        <MyoxusText
          component="div"
          data-myoxus-ui-role="mobile-rename-description"
          tone="secondary"
          typographySlot="body-small"
        >
          {description}
        </MyoxusText>
      </Stack>
      <Button
        block
        onClick={handleDone}
        disabled={!value}
        variant="primary"
        size="extraLarge"
        data-testid="rename-confirm"
        {...confirmButtonProps}
      >
        {confirmText}
      </Button>
    </Stack>
  );
};
