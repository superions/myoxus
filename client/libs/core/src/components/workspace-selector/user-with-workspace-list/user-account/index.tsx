import { MenuDetailRow, MenuInlineText } from "@myoxus/ui-facade";

export const UserAccountItem = ({
  email,
}: {
  email: string;
  onClick?: () => void;
  onEventEnd?: () => void;
}) => {
  return (
    <MenuDetailRow data-myoxus-ui-role="workspace-account-row">
      <MenuInlineText>{email}</MenuInlineText>
    </MenuDetailRow>
  );
};
