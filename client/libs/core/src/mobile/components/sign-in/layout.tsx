import {
  AuthBackgroundArt,
  SignInPageContainer,
  Stack,
} from "@myoxus/ui-facade";
import type { PropsWithChildren } from "react";

export const MobileSignInLayout = ({ children }: PropsWithChildren) => {
  return (
    <SignInPageContainer>
      <AuthBackgroundArt />
      <Stack data-myoxus-ui-role="mobile-sign-in-content" w="100%">
        {children}
      </Stack>
    </SignInPageContainer>
  );
};
