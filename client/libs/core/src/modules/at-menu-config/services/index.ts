import { UserFriendlyError } from "@myoxus/error";
import { DocRole, ErrorNames } from "@myoxus/graphql";
import { I18n, i18nTime } from "@myoxus/i18n";
import { Service } from "@myoxus/infra";
import track from "@myoxus/track";
import { notify } from "@myoxus/ui-facade";
import { computed, Signal } from "@preact/signals-core";
import type { DocMode } from "@virgultum/editor/model";
import { DocModeProvider } from "@virgultum/editor/shared/services";
import type { MyoxusInlineEditor } from "@virgultum/editor/shared/types";
import {
  BLOCK_ID_ATTR,
  type BlockComponent,
  type EditorHost,
} from "@virgultum/editor/std";
import type { DocMeta, BlockModel } from "@virgultum/editor/store";
import {
  type LinkedMenuGroup,
  type LinkedMenuItem,
  type LinkedWidgetConfig,
  LinkedWidgetUtils,
} from "@virgultum/editor/widgets/linked-doc";
import Fuse from "fuse.js";
import {
  createAbsolutePositionFromRelativePosition,
  createRelativePositionFromTypeIndex,
  type Text as YText,
} from "yjs";

import type { WorkspaceDialogService } from "../../dialogs";
import type { DocsService } from "../../doc";
import type { DocDisplayMetaService } from "../../doc-display-meta";
import { type JournalService, suggestJournalDate } from "../../journal";
import { NotificationService } from "../../notification";
import type { GuardService, MemberSearchService } from "../../permissions";
import type { DocGrantedUsersService } from "../../permissions/services/doc-granted-users";
import type { SearchMenuService } from "../../search-menu/services";
import { AuthService, type WorkspaceServerService } from "../../server";

function resolveSignal<T>(data: T | Signal<T>): T {
  return data instanceof Signal ? data.value : data;
}

const RESERVED_ITEM_KEYS = {
  createPage: "create:page",
  createEdgeless: "create:edgeless",
  datePicker: "date-picker",
};
export interface PagePickerTarget {
  insertDocument(id: string): void;
  openEmbedSection?(): void;
  insertMember(id: string): MentionOccurrence | undefined;
  anchorRect(): DOMRect;
}
type MentionOccurrence = {
  model: BlockModel;
  text: YText;
  index: number;
  mode: DocMode;
};
type PickerInput = MyoxusInlineEditor | PagePickerTarget;

export class AtMenuConfigService extends Service {
  constructor(
    private readonly journalService: JournalService,
    private readonly docDisplayMetaService: DocDisplayMetaService,
    private readonly dialogService: WorkspaceDialogService,
    private readonly docsService: DocsService,
    private readonly searchMenuService: SearchMenuService,
    private readonly workspaceServerService: WorkspaceServerService,
    private readonly memberSearchService: MemberSearchService,
    private readonly guardService: GuardService,
    private readonly docGrantedUsersService: DocGrantedUsersService,
  ) {
    super();
  }

  // todo(@peng17): maybe refactor the config using entity, so that each config
  // can be reactive to the query, instead of recreating the whole config?
  getConfig(): Partial<LinkedWidgetConfig> {
    return {
      getMenus: this.getMenusFn(),
      mobile: this.getMobileConfig(),
      autoFocusedItemKey: this.autoFocusedItemKey,
    };
  }

  private insertDoc(inlineEditor: PickerInput, id: string) {
    if ("insertDocument" in inlineEditor)
      return inlineEditor.insertDocument(id);
    LinkedWidgetUtils.insertLinkedNode({
      inlineEditor,
      docId: id,
    });
  }

  readonly autoFocusedItemKey = (
    menus: LinkedMenuGroup[],
    query: string,
  ): string | null => {
    if (query.trim().length === 0) {
      return null;
    }

    const linkToDocGroup = menus[0];
    const memberGroup = menus[1];

    if (
      memberGroup?.name ===
        I18n.t("com.myoxus.editor.at-menu.mention-members") &&
      resolveSignal(memberGroup.items).length > 1
    ) {
      return resolveSignal(memberGroup.items)[0]?.key;
    }

    if (linkToDocGroup && resolveSignal(linkToDocGroup.items).length > 0) {
      return resolveSignal(linkToDocGroup.items)[0]?.key;
    }

    return RESERVED_ITEM_KEYS.createPage;
  };

  private newDocMenuGroup(
    query: string,
    close: () => void,
    editorHost: EditorHost | null,
    inlineEditor: PickerInput,
  ): LinkedMenuGroup {
    const originalNewDocMenuGroup =
      editorHost && !("insertDocument" in inlineEditor)
        ? LinkedWidgetUtils.createNewDocMenuGroup(
            query,
            close,
            editorHost,
            inlineEditor,
          )
        : null;

    // Patch the import item, to use the custom import dialog.
    const items = originalNewDocMenuGroup
      ? resolveSignal(originalNewDocMenuGroup.items)
      : [];

    const importItem = items.find((item) => item.key === "import");

    if (!importItem && originalNewDocMenuGroup) {
      return originalNewDocMenuGroup;
    }

    const createPage = (mode: DocMode) => {
      const page = this.docsService.createDoc({
        title: query,
        primaryMode: mode,
      });

      return page;
    };

    const customNewDocItems: LinkedMenuItem[] = [
      {
        key: RESERVED_ITEM_KEYS.createPage,
        icon: "NewXxxPageIcon",
        name: I18n.t("com.myoxus.editor.at-menu.create-page", {
          name: query || I18n.t("Untitled"),
        }),
        action: () => {
          close();
          const page = createPage("page");
          this.insertDoc(inlineEditor, page.id);
          track.doc.editor.atMenu.createDoc({
            mode: "page",
          });
        },
      },
      {
        key: RESERVED_ITEM_KEYS.createEdgeless,
        icon: "NewXxxEdgelessIcon",
        name: I18n.t("com.myoxus.editor.at-menu.create-edgeless", {
          name: query || I18n.t("Untitled"),
        }),
        action: () => {
          close();
          const page = createPage("edgeless");
          this.insertDoc(inlineEditor, page.id);
          track.doc.editor.atMenu.createDoc({
            mode: "edgeless",
          });
        },
      },
    ];
    const customImportItem: LinkedMenuItem = {
      key: "import",
      icon: "ImportIcon",
      ...importItem,
      name: I18n.t("com.myoxus.editor.at-menu.import"),
      action: () => {
        close();
        track.doc.editor.atMenu.import();
        this.dialogService.open("import", undefined, (payload) => {
          if (!payload) {
            return;
          }

          // If the imported file is a workspace file, insert the entry page node.
          const { docIds, entryId, isWorkspaceFile } = payload;
          if (isWorkspaceFile && entryId) {
            this.insertDoc(inlineEditor, entryId);
            return;
          }

          // Otherwise, insert all the doc nodes.
          for (const docId of docIds) {
            this.insertDoc(inlineEditor, docId);
          }
        });
      },
    };

    return {
      ...originalNewDocMenuGroup,
      name: I18n.t("com.myoxus.editor.at-menu.new-doc"),
      items: [...customNewDocItems, customImportItem],
    };
  }

  private journalGroup(
    query: string,
    close: () => void,
    inlineEditor: PickerInput,
  ): LinkedMenuGroup {
    const suggestedDate = suggestJournalDate(query);

    const items: LinkedMenuItem[] = [
      {
        icon: "DateTimeIcon",
        key: RESERVED_ITEM_KEYS.datePicker,
        name: I18n.t("com.myoxus.editor.at-menu.date-picker"),
        action: () => {
          close();

          const getRect = () => {
            if ("anchorRect" in inlineEditor) return inlineEditor.anchorRect();
            if (!inlineEditor.rootElement) {
              return { x: 0, y: 0, width: 0, height: 0 };
            }
            let rect = inlineEditor.getNativeRange()?.getBoundingClientRect();

            if (!rect || rect.width === 0 || rect.height === 0) {
              rect = inlineEditor.rootElement.getBoundingClientRect();
            }

            return rect;
          };

          const { x, y, width, height } = getRect();

          const id = this.dialogService.open("date-selector", {
            position: [x, y, width, height || 20],
            onSelect: (date) => {
              if (date) {
                onSelectDate(date);
                track.doc.editor.atMenu.linkDoc({
                  journal: true,
                  type: "specific date",
                });
                this.dialogService.close(id);
              }
            },
          });
        },
      },
    ];

    const onSelectDate = (date: string) => {
      close();
      const doc = this.journalService.ensureJournalByDate(date);
      this.insertDoc(inlineEditor, doc.id);
    };

    if (suggestedDate) {
      const { dateString, alias } = suggestedDate;
      const dateDisplay = i18nTime(dateString, {
        absolute: { accuracy: "day" },
      });

      items.unshift({
        icon: this.docDisplayMetaService.getJournalIconName(dateString),
        key: RESERVED_ITEM_KEYS.datePicker + ":" + dateString,
        name: alias ? `${alias}, ${dateDisplay}` : dateDisplay,
        action: () => {
          track.doc.editor.atMenu.linkDoc({
            journal: true,
            type: alias,
          });
          onSelectDate(dateString);
        },
      });
    }

    return {
      name: I18n.t("com.myoxus.editor.at-menu.journal"),
      items,
    };
  }

  private linkToDocGroup(
    query: string,
    close: () => void,
    inlineEditor: PickerInput,
    abortSignal: AbortSignal,
  ): LinkedMenuGroup {
    const action = (meta: DocMeta) => {
      close();
      track.doc.editor.atMenu.linkDoc();
      this.insertDoc(inlineEditor, meta.id);
    };
    const result = this.searchMenuService.getDocMenuGroup(
      query,
      action,
      abortSignal,
    );
    const filterItem = (item: LinkedMenuItem) => {
      const isJournal = !!this.journalService.getJournalDate(item.key);
      return !isJournal;
    };
    const embedSectionItem: LinkedMenuItem | null =
      "openEmbedSection" in inlineEditor && inlineEditor.openEmbedSection
        ? {
            key: "embed-section",
            icon: "BlockLinkIcon",
            name: I18n.t("com.myoxus.wiki.embed.title"),
            action: () => {
              inlineEditor.openEmbedSection?.();
            },
          }
        : null;
    const items = result.items;
    if (Array.isArray(items)) {
      result.items = [
        ...items.filter(filterItem),
        ...(embedSectionItem ? [embedSectionItem] : []),
      ];
    } else {
      result.items = computed(() => [
        ...items.value.filter(filterItem),
        ...(embedSectionItem ? [embedSectionItem] : []),
      ]);
    }
    return result;
  }

  private memberGroup(
    query: string,
    close: () => void,
    inlineEditor: PickerInput,
    _: AbortSignal,
  ): LinkedMenuGroup {
    const getMenuItem = (
      id: string,
      name?: string | null,
      avatar?: string | null,
      sendNotification: boolean = true,
    ): LinkedMenuItem => {
      return {
        key: id,
        name: name ?? "Unknown",
        icon: "UserIcon",
        avatar: avatar ?? undefined,
        action: () => {
          const notificationService =
            this.workspaceServerService.server?.scope.get(NotificationService);
          if (!notificationService) return;
          let occurrence: MentionOccurrence | undefined;
          if ("insertMember" in inlineEditor)
            occurrence = inlineEditor.insertMember(id);
          else {
            const block = inlineEditor.rootElement?.closest<BlockComponent>(
              `[${BLOCK_ID_ATTR}]`,
            );
            if (!block || block.store.readonly) return;
            close();
            const range = inlineEditor.getInlineRange();
            if (!range || range.length) return;
            inlineEditor.insertText(range, " ", { mention: { member: id } });
            inlineEditor.setInlineRange({ index: range.index + 1, length: 0 });
            occurrence = {
              model: block.model,
              text: inlineEditor.yText,
              index: range.index,
              mode: block.std.get(DocModeProvider).getEditorMode() ?? "page",
            };
          }
          if (!occurrence) return;
          const { model, text, index, mode } = occurrence,
            doc = model.store,
            workspaceId = doc.workspace.id,
            docId = doc.id;
          track.doc.editor.atMenu.mentionMember({
            type: "member",
          });
          if (!sendNotification) return;
          // Bind the acknowledgement to both sides of the inserted occurrence.
          // Removal collapses the range even if the next marker names the same member.
          const from = createRelativePositionFromTypeIndex(text, index),
            to = createRelativePositionFromTypeIndex(text, index + 1, -1);
          notificationService
            .mentionUser(id, workspaceId, {
              id: docId,
              title: this.docDisplayMetaService.title$(docId).value,
              blockId: model.id,
              mode,
            })
            .then((notificationId) => {
              if (
                doc.readonly ||
                doc.getModelById(model.id) !== model ||
                doc.hasFixedText(model) ||
                !text.doc
              )
                return;
              const a = createAbsolutePositionFromRelativePosition(
                  from,
                  text.doc,
                ),
                b = createAbsolutePositionFromRelativePosition(to, text.doc);
              if (
                !a ||
                !b ||
                a.type !== text ||
                b.type !== text ||
                a.index + 1 !== b.index
              )
                return;
              let offset = 0;
              const delta = text
                .toDelta()
                .find(
                  (op: { insert: unknown }) =>
                    (offset +=
                      typeof op.insert === "string" ? op.insert.length : 1) >
                    a.index,
                );
              if (
                delta?.insert === " " &&
                delta.attributes?.mention?.member === id &&
                !delta.attributes.mention.notification
              )
                doc.transact(() =>
                  text.format(a.index, 1, {
                    mention: { member: id, notification: notificationId },
                  }),
                );
            })
            .catch((error) => {
              const err = UserFriendlyError.fromAny(error);

              if (err.is(ErrorNames.MENTION_USER_DOC_ACCESS_DENIED)) {
                track.doc.editor.atMenu.noAccessPrompted();

                const canUserManage = this.guardService.can$(
                  "Doc_Users_Manage",
                  docId,
                ).signal.value;
                if (canUserManage) {
                  const username = name ?? "Unknown";
                  notify.error({
                    title: I18n.t("com.myoxus.editor.at-menu.access-needed"),
                    message: I18n[
                      "com.myoxus.editor.at-menu.access-needed-message"
                    ]({
                      username,
                    }),
                    actions: [
                      {
                        key: "invite",
                        label: I18n.t("Invite"),
                        onClick: async () => {
                          track.$.sharePanel.$.inviteUserDocRole({
                            control: "member list",
                            role: "reader",
                          });

                          try {
                            await this.docGrantedUsersService.updateUserRole(
                              id,
                              DocRole.Reader,
                            );

                            await notificationService.mentionUser(
                              id,
                              workspaceId,
                              {
                                id: docId,
                                title:
                                  this.docDisplayMetaService.title$(docId)
                                    .value,
                                blockId: model.id,
                                mode,
                              },
                            );

                            notify.success({
                              title: I18n.t(
                                "com.myoxus.editor.at-menu.invited-and-notified",
                              ),
                            });
                          } catch (error) {
                            const err = UserFriendlyError.fromAny(error);
                            notify.error({
                              title: I18n[`error.${err.name}`](err.data),
                            });
                          }
                        },
                      },
                    ],
                  });
                } else {
                  notify.error({
                    title: I18n.t(
                      "com.myoxus.editor.at-menu.member-not-notified",
                    ),
                    message:
                      I18n[
                        "com.myoxus.editor.at-menu.member-not-notified-message"
                      ](),
                  });
                }

                return;
              }

              notify.error({
                title: I18n[`error.${err.name}`](err.data),
              });
            });
        },
      };
    };

    const inviteItem: LinkedMenuItem = {
      key: "invite",
      name: I18n.t("Invite Members"),
      icon: "UserIcon",
      action: () => {
        close();

        track.doc.editor.atMenu.mentionMember({
          type: "invite",
        });

        this.dialogService.open("workspace-settings", {
          activeTab: "workspace:members",
        });
      },
    };

    const items = computed<LinkedMenuItem[]>(() => {
      const members = this.memberSearchService.result$.signal.value;
      const currentUser =
        this.workspaceServerService.server?.scope.get(AuthService).session
          .account$.signal.value;
      const canUserManage = this.guardService.can$("Workspace_Users_Manage")
        .signal.value;

      if (query.length === 0) {
        return [
          ...(currentUser
            ? [
                getMenuItem(
                  currentUser.id,
                  currentUser.info?.name,
                  currentUser.info?.avatarUrl,
                  false,
                ),
              ]
            : []),
          ...members
            .slice(0, 2)
            .filter((member) => member.id !== currentUser?.id)
            .map((member) =>
              getMenuItem(member.id, member.name, member.avatarUrl),
            ),
          ...(canUserManage ? [inviteItem] : []),
        ];
      }

      // Create a single Fuse instance for all members
      const fuse = new Fuse(members, {
        keys: ["name"],
        includeMatches: true,
        includeScore: true,
        ignoreLocation: true,
        threshold: 0.0,
      });
      const searchResults = fuse.search(query);

      return [
        ...searchResults.map((result) => {
          const member = result.item;
          return {
            ...getMenuItem(
              member.id,
              member.name,
              member.avatarUrl,
              member.id !== currentUser?.id,
            ),
            highlights: result.matches?.flatMap((match) =>
              match.indices.map(([start, end]) => [start, end + 1] as const),
            ),
          };
        }),
        ...(canUserManage ? [inviteItem] : []),
      ];
    });
    const hidden = computed(() => {
      const members = this.memberSearchService.result$.signal.value;
      const loading = this.memberSearchService.isLoading$.signal.value;
      return query.length > 0 && !loading && members.length === 0;
    });

    if (query.length > 0) {
      this.memberSearchService.search(query);
    }

    return {
      name: I18n.t("com.myoxus.editor.at-menu.mention-members"),
      items,
      loading: this.memberSearchService.isLoading$.signal,
      hidden,
      maxDisplay: 3,
      overflowText: computed(() => {
        const totalCount = this.memberSearchService.result$.signal.value.length;
        const remainingCount = totalCount - 3;
        return I18n.t("com.myoxus.editor.at-menu.more-members-hint", {
          count: remainingCount,
        });
      }),
    };
  }

  private getMenusFn(): LinkedWidgetConfig["getMenus"] {
    return (query, close, host, editor, abort, trigger) =>
      this.groups(query, close, host, editor, abort, trigger);
  }

  pageGroups(
    query: string,
    close: () => void,
    input: PagePickerTarget,
    abort: AbortSignal,
    trigger: string,
  ) {
    return this.groups(query, close, null, input, abort, trigger);
  }

  private groups(
    query: string,
    close: () => void,
    editorHost: EditorHost | null,
    inlineEditor: PickerInput,
    abortSignal: AbortSignal,
    triggerKey = "@",
  ) {
    if (triggerKey === "[[" || triggerKey === "【【") {
      const documents = this.linkToDocGroup(
        query,
        close,
        inlineEditor,
        abortSignal,
      );
      documents.emptyMessage = I18n.t("com.myoxus.cmdk.no-results");
      const create = this.newDocMenuGroup(
        query,
        close,
        editorHost,
        inlineEditor,
      );
      const items = resolveSignal(create.items);
      const canCreate = this.guardService.can$("Workspace_CreateDoc").signal;
      const pageItems = items
        .filter((item) => item.key === RESERVED_ITEM_KEYS.createPage)
        .map((item) => ({
          ...item,
          action: () => {
            if (canCreate.value) return item.action();
          },
        }));
      create.items = computed(() => (canCreate.value ? pageItems : []));
      return [documents, create];
    }
    return [
      this.linkToDocGroup(query, close, inlineEditor, abortSignal),
      this.memberGroup(query, close, inlineEditor, abortSignal),
      this.journalGroup(query, close, inlineEditor),
      this.newDocMenuGroup(query, close, editorHost, inlineEditor),
    ];
  }

  private getMobileConfig(): Partial<LinkedWidgetConfig["mobile"]> {
    return {
      scrollContainer: window,
      scrollTopOffset: () => {
        const header = document.querySelector("header");
        if (!header) return 0;

        const { y, height } = header.getBoundingClientRect();
        return y + height;
      },
    };
  }
}
