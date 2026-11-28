// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { MemberSearchService } from "@myoxus/core/modules/permissions";
import { I18n } from "@myoxus/i18n";
import type { FrameworkProvider } from "@myoxus/infra";
import track from "@myoxus/track";
import { computed } from "@preact/signals-core";
import { BLOCK_ID_ATTR, type BlockComponent } from "@virgultum/core/runtime";
import type { MyoxusInlineEditor } from "@virgultum/editor/shared/types";
import type {
  LinkedMenuItem,
  LinkedWidgetConfig,
} from "@virgultum/editor/widgets/linked-doc";
import Fuse from "fuse.js";

const MAX_VISIBLE_MEMBERS = 3;

export const createCommentLinkedWidgetConfig = (
  framework: FrameworkProvider,
): Partial<LinkedWidgetConfig> => {
  const buildMemberGroup = (
    query: string,
    close: () => void,
    inlineEditor: MyoxusInlineEditor,
  ) => {
    const memberSearchService = framework.get(MemberSearchService);
    memberSearchService.search(query);

    const toMenuItem = (
      id: string,
      name?: string | null,
      avatar?: string | null,
    ): LinkedMenuItem => ({
      key: id,
      name: name ?? "Unknown",
      icon: "UserIcon",
      avatar: avatar ?? undefined,
      action: () => {
        const block = inlineEditor.rootElement?.closest<BlockComponent>(
          `[${BLOCK_ID_ATTR}]`,
        );
        if (!block) return;

        close();
        track.doc.editor.atMenu.mentionMember({ type: "member" });

        const range = inlineEditor.getInlineRange();
        if (!range || range.length !== 0) return;

        inlineEditor.insertText(range, " ", { mention: { member: id } });
        inlineEditor.setInlineRange({ index: range.index + 1, length: 0 });
      },
    });

    const items = computed<LinkedMenuItem[]>(() => {
      const members = memberSearchService.result$.signal.value;
      if (query.length === 0) {
        return members
          .slice(0, MAX_VISIBLE_MEMBERS)
          .map((member) =>
            toMenuItem(member.id, member.name, member.avatarUrl),
          );
      }

      const fuse = new Fuse(members, {
        keys: ["name"],
        includeMatches: true,
        includeScore: true,
        ignoreLocation: true,
        threshold: 0.0,
      });

      return fuse.search(query).map((hit) => ({
        ...toMenuItem(hit.item.id, hit.item.name, hit.item.avatarUrl),
        highlights: hit.matches?.flatMap((match) =>
          match.indices.map(([start, end]) => [start, end + 1] as const),
        ),
      }));
    });

    return {
      name: I18n.t("com.myoxus.editor.at-menu.mention-members"),
      items,
      loading: memberSearchService.isLoading$.signal,
      hidden: computed(
        () =>
          memberSearchService.result$.signal.value.length === 0 &&
          !memberSearchService.isLoading$.signal.value,
      ),
      maxDisplay: MAX_VISIBLE_MEMBERS,
      overflowText: computed(() =>
        I18n.t("com.myoxus.editor.at-menu.more-members-hint", {
          count:
            memberSearchService.result$.signal.value.length -
            MAX_VISIBLE_MEMBERS,
        }),
      ),
    };
  };

  return {
    getMenus: (query, close, _editorHost, inlineEditor) => [
      buildMemberGroup(query, close, inlineEditor),
    ],
  };
};
