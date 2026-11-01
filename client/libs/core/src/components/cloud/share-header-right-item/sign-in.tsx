import { GlobalDialogService } from "@myoxus/core/modules/dialogs";
import { useI18n } from "@myoxus/i18n";
import { useService } from "@myoxus/infra";
import { Button } from "@myoxus/ui-facade";
import { useCallback } from "react";

export const SignIn = () => {
  const globalDialogService = useService(GlobalDialogService);

  const t = useI18n();

  const onClickSignIn = useCallback(() => {
    globalDialogService.open("sign-in", {});
  }, [globalDialogService]);

  return (
    <Button onClick={onClickSignIn} data-testid="share-page-sign-in-button">
      {t["com.myoxus.share-page.header.login"]()}
    </Button>
  );
};
