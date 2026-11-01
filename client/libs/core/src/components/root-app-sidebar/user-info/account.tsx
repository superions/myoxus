import { AuthService } from "@myoxus/core/modules/server";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Avatar,
  MenuDetailRow,
  MyoxusText,
  SidebarIdentitySummary,
  SidebarIdentityText,
} from "@myoxus/ui-facade";

export const Account = () => {
  const account = useLiveData(useService(AuthService).session.account$);
  if (!account) {
    // TODO(@JimmFly): loading ui
    return null;
  }
  return (
    <MenuDetailRow
      data-testid="user-info-card"
      data-myoxus-ui-role="sidebar-account-summary"
      density="spacious"
      justify="start"
      panelWidth="wide"
    >
      <SidebarIdentitySummary>
        <Avatar colorfulFallback name={account.label} url={account.avatar} />
        <SidebarIdentityText>
          <MyoxusText
            component="span"
            truncate
            typographySlot="nav"
            fallbackSlot="body-small"
            data-myoxus-ui-role="sidebar-account-name"
          >
            {account.label}
          </MyoxusText>
          <MyoxusText
            component="span"
            truncate
            tone="secondary"
            typographySlot="caption"
            fallbackSlot="body-small"
            data-myoxus-ui-role="sidebar-account-email"
          >
            {account.email}
          </MyoxusText>
        </SidebarIdentityText>
      </SidebarIdentitySummary>
    </MenuDetailRow>
  );
};
