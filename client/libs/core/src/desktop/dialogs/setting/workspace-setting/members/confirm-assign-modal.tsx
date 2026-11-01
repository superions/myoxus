import type { Member } from "@myoxus/core/modules/permissions";
import { useI18n } from "@myoxus/i18n";

import {
  ConfirmModal,
  FormRow,
  Input,
  SettingsNotice,
  Stack,
} from "../../primitives";

export const ConfirmAssignModal = ({
  open,
  setOpen,
  member,
  inputValue,
  placeholder,
  setInputValue,
  isEquals,
  onConfirm,
}: {
  open: boolean;
  setOpen: (value: boolean) => void;
  isEquals: boolean;
  member: Member;
  inputValue: string;
  placeholder?: string;
  onConfirm: () => void;
  setInputValue: (value: string) => void;
}) => {
  const t = useI18n();

  return (
    <ConfirmModal
      open={open}
      onOpenChange={setOpen}
      title={t["com.myoxus.member.assign.confirm.title"]()}
      description={t["com.myoxus.member.assign.confirm.description"]({
        name: member.name || member.email || member.id,
      })}
      confirmText={t["com.myoxus.member.assign.confirm.button"]()}
      onConfirm={onConfirm}
      confirmButtonOptions={{ disabled: !isEquals, variant: "error" }}
    >
      <Stack>
        <SettingsNotice tone="warning">
          {[
            t["com.myoxus.member.assign.confirm.description-1"](),
            t["com.myoxus.member.assign.confirm.description-2"](),
            t["com.myoxus.member.assign.confirm.description-3"](),
          ].join(" ")}
        </SettingsNotice>

        <FormRow label={t["com.myoxus.member.assign.confirm.description-4"]()}>
          <Input
            block
            value={inputValue}
            onChange={setInputValue}
            placeholder={placeholder}
          />
        </FormRow>
      </Stack>
    </ConfirmModal>
  );
};
