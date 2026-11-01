import { useI18n } from "@myoxus/i18n";
import { SearchIcon } from "@myoxus/icons/react";
import { Input } from "@myoxus/ui-facade";

export const InviteInput = ({ onFocus }: { onFocus: () => void }) => {
  const t = useI18n();

  return (
    <Input
      preFix={<SearchIcon />}
      onFocus={onFocus}
      block
      placeholder={t["com.myoxus.share-menu.invite-editor.placeholder"]()}
    />
  );
};
