// SPDX-License-Identifier: AGPL-3.0-or-later

import { NotificationList } from "@myoxus/core/components/notification/list";
import {
  NotificationCountService,
  NotificationService,
} from "@myoxus/core/modules/notification";
import {
  ViewBody,
  ViewHeader,
  ViewIcon,
  ViewTitle,
  WorkbenchService,
} from "@myoxus/core/modules/workbench";
import { UserFriendlyError } from "@myoxus/error";
import { useI18n } from "@myoxus/i18n";
import { CheckIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Button,
  Group,
  MyoxusSegmentedControl,
  MyoxusText,
  notify,
  PageContentRail,
  Select,
  Stack,
  WorkbenchHeaderContextPath,
  WorkbenchHeaderFrame,
} from "@myoxus/ui-facade";
import { useCallback, useEffect, useMemo } from "react";
import { useSearchParams } from "react-router";

import {
  type InboxReadScope,
  type InboxTypeScope,
  inboxWorkbenchPath,
  normalizeInboxSearch,
  normalizeTypeScope,
  toInboxFeedFilter,
} from "./model";

export const InboxPage = () => {
  const t = useI18n();
  const notificationService = useService(NotificationService);
  const workbench = useService(WorkbenchService).workbench;
  const notificationCount = useLiveData(
    useService(NotificationCountService).count$,
  );
  const [searchParams] = useSearchParams();
  const {
    read: readScope,
    type: typeScope,
    canonicalSearch,
  } = normalizeInboxSearch(searchParams);
  const filter = useMemo(
    () => toInboxFeedFilter(readScope, typeScope),
    [readScope, typeScope],
  );
  const feed = useMemo(
    () => notificationService.createFeed(filter),
    [filter, notificationService],
  );
  const isLoading = useLiveData(feed.isLoading$);

  useEffect(() => {
    if (searchParams.toString() === canonicalSearch) return;
    workbench.open(`/inbox?${canonicalSearch}`, {
      at: "active",
      replaceHistory: true,
    });
  }, [canonicalSearch, searchParams, workbench]);

  const updateScope = useCallback(
    (nextRead: InboxReadScope, nextType: InboxTypeScope) => {
      workbench.open(inboxWorkbenchPath(nextRead, nextType), {
        at: "active",
      });
    },
    [workbench],
  );

  const markAllRead = useCallback(() => {
    feed.readAllNotifications().catch((error) => {
      notify.error(UserFriendlyError.fromAny(error));
    });
  }, [feed]);

  const typeOptions = [
    { value: "all", label: t["com.myoxus.notification.filter.all"]() },
    {
      value: "document-changes",
      label: t["com.myoxus.notification.filter.document-changes"](),
    },
    {
      value: "mentions",
      label: t["com.myoxus.notification.filter.mentions"](),
    },
    {
      value: "comments",
      label: t["com.myoxus.comment.comments"](),
    },
    {
      value: "invites",
      label: t["com.myoxus.notification.filter.invites"](),
    },
    {
      value: "reminders",
      label: t["com.myoxus.notification.filter.reminders"](),
    },
  ];

  return (
    <>
      <ViewTitle title={t["com.myoxus.rootAppSidebar.notifications"]()} />
      <ViewIcon icon="inbox" />
      <ViewHeader>
        <WorkbenchHeaderFrame
          data-myoxus-ui-role="inbox-header-frame"
          title={
            <WorkbenchHeaderContextPath
              current={t["com.myoxus.rootAppSidebar.notifications"]()}
              data-myoxus-ui-role="inbox-header-title"
            />
          }
        />
      </ViewHeader>
      <ViewBody>
        <PageContentRail
          fill
          scroll
          spacious
          width="data"
          data-myoxus-ui-role="inbox-content-rail"
        >
          <Stack gap="lg" w="100%" data-myoxus-ui-role="inbox-route">
            <Group align="flex-end" justify="space-between" wrap="wrap">
              <Stack gap="xs">
                <MyoxusText typographySlot="section-title">
                  {t["com.myoxus.rootAppSidebar.notifications"]()}
                </MyoxusText>
                <MyoxusText tone="secondary">
                  {t["com.myoxus.notification.inbox.description"]()}
                </MyoxusText>
              </Stack>
              {typeScope === "all" ? (
                <Button
                  variant="secondary"
                  prefix={<CheckIcon />}
                  disabled={isLoading || notificationCount === 0}
                  onClick={markAllRead}
                >
                  {t["com.myoxus.notification.mark-all-read"]()}
                </Button>
              ) : null}
            </Group>

            <Group align="flex-end" wrap="wrap">
              <MyoxusSegmentedControl
                aria-label={t["com.myoxus.notification.filter.read-scope"]()}
                value={readScope}
                data={[
                  {
                    value: "unread",
                    label: t["com.myoxus.notification.filter.unread"](),
                  },
                  {
                    value: "all",
                    label: t["com.myoxus.notification.filter.history"](),
                  },
                ]}
                onChange={(value) =>
                  updateScope(value as InboxReadScope, typeScope)
                }
                data-myoxus-ui-role="inbox-read-filter"
              />
              <Select
                aria-label={t["com.myoxus.notification.filter.type"]()}
                value={typeScope}
                data={typeOptions}
                onChange={(value) =>
                  updateScope(readScope, normalizeTypeScope(value))
                }
                data-myoxus-ui-role="inbox-type-filter"
              />
            </Group>

            <NotificationList
              feed={feed}
              grouped
              mode="route"
              showHeader={false}
            />
          </Stack>
        </PageContentRail>
      </ViewBody>
    </>
  );
};

export const Component = InboxPage;
