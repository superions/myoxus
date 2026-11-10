import { MemberSearchService } from "@myoxus/core/modules/permissions";
import { I18n } from "@myoxus/i18n";
import type { FrameworkProvider } from "@myoxus/infra";
import track from "@myoxus/track";
import { computed } from "@preact/signals-core";
import type { MyoxusInlineEditor } from "@virgultum/editor/shared/types";
import type {
  LinkedMenuItem,
  LinkedWidgetConfig,
} from "@virgultum/editor/widgets/linked-doc";
import { BLOCK_ID_ATTR, type BlockComponent } from "@virgultum/std";
import Fuse from "fuse.js";

export const createCommentLinkedWidgetConfig = (
  framework: FrameworkProvider,
): Partial<LinkedWidgetConfig> | undefined => {
  const memberGroup = (
    query: string,
    close: () => void,
    inlineEditor: MyoxusInlineEditor,
  ) => {
    const memberSearchService = framework.get(MemberSearchService);

    const getMenuItem = (
      id: string,
      name?: string | null,
      avatar?: string | null,
    ): LinkedMenuItem => {
      return {
        key: id,
        name: name ?? "Unknown",
        icon: "UserIcon",
        avatar: avatar ?? undefined,
        action: () => {
          const root = inlineEditor.rootElement;
          const block = root?.closest<BlockComponent>(`[${BLOCK_ID_ATTR}]`);
          if (!block) return;

          close();

          track.doc.editor.atMenu.mentionMember({
            type: "member",
          });

          const inlineRange = inlineEditor.getInlineRange();
          if (!inlineRange || inlineRange.length !== 0) return;

          inlineEditor.insertText(inlineRange, " ", {
            mention: {
              member: id,
            },
          });
          inlineEditor.setInlineRange({
            index: inlineRange.index + 1,
            length: 0,
          });
        },
      };
    };
    memberSearchService.search(query);

    const items = computed<LinkedMenuItem[]>(() => {
      const members = memberSearchService.result$.signal.value;

      if (query.length === 0) {
        return members
          .slice(0, 3)
          .map((member) =>
            getMenuItem(member.id, member.name, member.avatarUrl),
          );
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

      return searchResults.map((result) => {
        const member = result.item;
        return {
          ...getMenuItem(member.id, member.name, member.avatarUrl),
          highlights: result.matches?.flatMap((match) =>
            match.indices.map(([start, end]) => [start, end + 1] as const),
          ),
        };
      });
    });

    return {
      name: I18n.t("com.myoxus.editor.at-menu.mention-members"),
      items,
      loading: memberSearchService.isLoading$.signal,
      hidden: computed(() => {
        return (
          memberSearchService.result$.signal.value.length === 0 &&
          !memberSearchService.isLoading$.signal.value
        );
      }),
      maxDisplay: 3,
      overflowText: computed(() => {
        const totalCount = memberSearchService.result$.signal.value.length;
        const remainingCount = totalCount - 3;
        return I18n.t("com.myoxus.editor.at-menu.more-members-hint", {
          count: remainingCount,
        });
      }),
    };
  };

  return {
    getMenus: (query, close, _editorHost, inlineEditor) => {
      return [memberGroup(query, close, inlineEditor)];
    },
  };
};
