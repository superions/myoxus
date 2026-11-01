import { ShareInfoService } from "@myoxus/core/modules/share-doc";
import type { WorkspaceMetadata } from "@myoxus/core/modules/workspace";
import { useI18n } from "@myoxus/i18n";
import { LockIcon, PublishIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Button,
  Menu,
  Stack,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
} from "@myoxus/ui-facade";
import type { Store } from "@virgultum/editor/store";
import {
  forwardRef,
  type PropsWithChildren,
  type Ref,
  useCallback,
  useEffect,
  useState,
} from "react";

import { InviteMemberEditor } from "./invite-member-editor/invite-member-editor";
import { MemberManagement } from "./member-management";
import { ShareExport } from "./share-export";
import { SharePage } from "./share-page";

export interface ShareMenuProps extends PropsWithChildren {
  workspaceMetadata: WorkspaceMetadata;
  currentPage: Store;
  onEnableServer: () => void;
  onOpenShareModal?: (open: boolean) => void;
  disabled?: boolean;
  disabledReason?: string;
}

export enum ShareMenuTab {
  Share = "share",
  Export = "export",
  Invite = "invite",
  Members = "members",
}

export const ShareMenuContent = (props: ShareMenuProps) => {
  const t = useI18n();
  const [currentTab, setCurrentTab] = useState(ShareMenuTab.Share);

  const onValueChange = useCallback((value: string) => {
    setCurrentTab(value as ShareMenuTab);
  }, []);

  if (currentTab === ShareMenuTab.Members) {
    return (
      <MemberManagement
        onClickBack={() => {
          setCurrentTab(ShareMenuTab.Share);
        }}
        onClickInvite={() => {
          setCurrentTab(ShareMenuTab.Invite);
        }}
      />
    );
  }
  if (currentTab === ShareMenuTab.Invite) {
    return (
      <InviteMemberEditor
        onClickCancel={() => {
          setCurrentTab(ShareMenuTab.Share);
        }}
      />
    );
  }
  return (
    <Stack data-myoxus-ui-role="share-menu">
      <Tabs
        layout="embedded"
        defaultValue={ShareMenuTab.Share}
        value={currentTab}
        onValueChange={onValueChange}
      >
        <TabsList variant="panel">
          <TabsTrigger grow value={ShareMenuTab.Share} variant="panel">
            {t["com.myoxus.share-menu.shareButton"]()}
          </TabsTrigger>
          {!BUILD_CONFIG.isMobileEdition ? (
            <TabsTrigger grow value={ShareMenuTab.Export} variant="panel">
              {t["Export"]()}
            </TabsTrigger>
          ) : null}
        </TabsList>
        <TabsContent flush layout="stack" value={ShareMenuTab.Share}>
          <SharePage
            onClickInvite={() => {
              setCurrentTab(ShareMenuTab.Invite);
            }}
            onClickMembers={() => {
              setCurrentTab(ShareMenuTab.Members);
            }}
            {...props}
          />
        </TabsContent>
        <TabsContent flush layout="stack" value={ShareMenuTab.Export}>
          <ShareExport />
        </TabsContent>
      </Tabs>
    </Stack>
  );
};

const DefaultShareButton = forwardRef(function DefaultShareButton(
  props: { disabled?: boolean; tooltip?: string },
  ref: Ref<HTMLButtonElement>,
) {
  const t = useI18n();
  const shareInfoService = useService(ShareInfoService);
  const shared = useLiveData(shareInfoService.shareInfo.isShared$);

  useEffect(() => {
    if (props.disabled) {
      return;
    }
    shareInfoService.shareInfo.revalidate();
  }, [props.disabled, shareInfoService]);

  const tooltip =
    props.tooltip ??
    (shared
      ? t["com.myoxus.share-menu.option.link.readonly.description"]()
      : t["com.myoxus.share-menu.option.link.no-access.description"]());

  return (
    <Tooltip content={tooltip}>
      <Button
        ref={ref}
        prefix={shared ? <PublishIcon /> : <LockIcon />}
        variant="primary"
        disabled={props.disabled}
        data-myoxus-ui-role="share-menu-trigger-button"
      >
        {t["com.myoxus.share-menu.shareButton"]()}
      </Button>
    </Tooltip>
  );
});

const LocalShareMenu = (props: ShareMenuProps) => {
  if (props.disabled) {
    return (
      <div data-testid="local-share-menu-button">
        <DefaultShareButton disabled tooltip={props.disabledReason} />
      </div>
    );
  }
  return (
    <Menu
      items={<ShareMenuContent {...props} />}
      contentOptions={{
        panelWidth: "large",
        panelPadding: "comfortable",
        ["data-testid" as string]: "local-share-menu",
        align: "end",
      }}
      rootOptions={{
        modal: false,
        onOpenChange: props.onOpenShareModal,
      }}
    >
      <div data-testid="local-share-menu-button">
        {props.children || <DefaultShareButton />}
      </div>
    </Menu>
  );
};

const CloudShareMenu = (props: ShareMenuProps) => {
  if (props.disabled) {
    return (
      <div data-testid="cloud-share-menu-button">
        <DefaultShareButton disabled tooltip={props.disabledReason} />
      </div>
    );
  }
  return (
    <Menu
      items={<ShareMenuContent {...props} />}
      contentOptions={{
        panelWidth: "large",
        panelPadding: "comfortable",
        ["data-testid" as string]: "cloud-share-menu",
        align: "end",
      }}
      rootOptions={{
        modal: false,
        onOpenChange: props.onOpenShareModal,
      }}
    >
      <div data-testid="cloud-share-menu-button">
        {props.children || <DefaultShareButton />}
      </div>
    </Menu>
  );
};

export const ShareMenu = (props: ShareMenuProps) => {
  const { workspaceMetadata } = props;

  if (workspaceMetadata.flavour === "local") {
    return <LocalShareMenu {...props} />;
  }
  return <CloudShareMenu {...props} />;
};
