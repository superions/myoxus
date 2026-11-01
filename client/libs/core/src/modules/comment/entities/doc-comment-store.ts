import {
  createCommentMutation,
  createReplyMutation,
  deleteCommentMutation,
  deleteReplyMutation,
  listCommentChangesQuery,
  type ListCommentsQuery,
  listCommentsQuery,
  resolveCommentMutation,
  updateCommentMutation,
  updateReplyMutation,
  uploadCommentAttachmentMutation,
} from "@myoxus/graphql";
import { Entity } from "@myoxus/infra";
import type { DocMode } from "@virgultum/editor/model";

import type {
  DefaultServerService,
  WorkspaceServerService,
} from "../../server";
import { GraphQLService } from "../../server/services/graphql";
import type { WorkspaceService } from "../../workspace";
import type {
  DocComment,
  DocCommentChangeListResult,
  DocCommentContent,
  DocCommentListResult,
  DocCommentReply,
} from "../types";
import { findMentions } from "./utils";

type GQLCommentType = NonNullable<
  ListCommentsQuery["workspace"]
>["comments"]["edges"][number]["node"];
type GQLReplyType = GQLCommentType["replies"][number];
type GQLUserType = GQLCommentType["user"];

// Helper functions for normalizing backend responses
const normalizeUser = (user: GQLUserType) => {
  const email = (user as { email?: unknown }).email;
  return {
    id: user.id,
    name: user.name,
    avatarUrl: user.avatarUrl,
    email: typeof email === "string" ? email : "",
  };
};

const normalizeContent = (
  content: DocCommentContent,
  resolveAttachmentUrl: (url: string) => string,
): DocCommentContent => ({
  ...content,
  attachments: content.attachments?.map((attachment) => ({
    ...attachment,
    url: attachment.url ? resolveAttachmentUrl(attachment.url) : attachment.url,
  })),
});

const normalizeReply = (
  reply: GQLReplyType,
  resolveAttachmentUrl: (url: string) => string,
): DocCommentReply => ({
  id: reply.id,
  commentId: reply.commentId,
  content: normalizeContent(
    reply.content as DocCommentContent,
    resolveAttachmentUrl,
  ),
  createdAt: new Date(reply.createdAt).getTime(),
  updatedAt: new Date(reply.updatedAt).getTime(),
  user: normalizeUser(reply.user),
  mentions: findMentions(reply.content.snapshot.blocks),
});

const normalizeComment = (
  comment: GQLCommentType,
  resolveAttachmentUrl: (url: string) => string,
): DocComment => ({
  id: comment.id,
  content: comment.content
    ? normalizeContent(
        comment.content as DocCommentContent,
        resolveAttachmentUrl,
      )
    : undefined,
  resolved: comment.resolved,
  createdAt: new Date(comment.createdAt).getTime(),
  updatedAt: new Date(comment.updatedAt).getTime(),
  user: comment.user
    ? normalizeUser(comment.user)
    : {
        id: "",
        name: "",
        email: "",
        avatarUrl: "",
      },
  mentions: comment.content
    ? findMentions(comment.content.snapshot.blocks)
    : [],
  replies:
    comment.replies?.map((reply) =>
      normalizeReply(reply, resolveAttachmentUrl),
    ) ?? [],
});

export class DocCommentStore extends Entity<{
  docId: string;
  getDocMode: () => DocMode;
  getDocTitle: () => string;
}> {
  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly workspaceServerService: WorkspaceServerService,
    private readonly defaultServerService: DefaultServerService,
  ) {
    super();
  }

  private get serverService() {
    return (
      this.workspaceServerService.server || this.defaultServerService.server
    );
  }

  private get graphqlService() {
    return this.serverService?.scope.get(GraphQLService);
  }

  private get currentWorkspaceId() {
    return this.workspaceService.workspace.id;
  }

  private get attachmentDownloadPrefix(): string {
    const server = this.serverService;
    if (!server) throw new Error("Server not found");
    return new URL(
      `/api/workspaces/${encodeURIComponent(this.currentWorkspaceId)}/docs/${encodeURIComponent(this.props.docId)}/comment-attachments/`,
      server.baseUrl,
    ).toString();
  }

  private readonly resolveAttachmentUrl = (url: string): string => {
    // Uploads and persisted comments contain storage keys, not browser URLs.
    // Encode the entire key as one route parameter; filenames may contain #/?/Unicode.
    return url.startsWith("comment-attachments/")
      ? this.attachmentDownloadPrefix + encodeURIComponent(url)
      : url;
  };

  private readonly serializeAttachmentUrl = (url: string): string => {
    // Persist keys so another client/server origin can resolve the same attachment.
    // Only undo our own download projection; existing unrelated URLs stay intact.
    const prefix = this.attachmentDownloadPrefix;
    return url.startsWith(prefix)
      ? decodeURIComponent(url.slice(prefix.length))
      : url;
  };

  async listComments({
    after,
    signal,
  }: {
    after?: string;
    signal?: AbortSignal;
  }): Promise<DocCommentListResult> {
    const graphql = this.graphqlService;
    if (!graphql) {
      throw new Error("GraphQL service not found");
    }
    const response = await graphql.gql({
      query: listCommentsQuery,
      variables: {
        pagination: {
          after,
        },
        workspaceId: this.currentWorkspaceId,
        docId: this.props.docId,
      },
      context: { signal },
    });

    const comments = response.workspace?.comments;
    if (!comments) {
      return {
        comments: [],
        hasNextPage: false,
        startCursor: "",
        endCursor: "",
      };
    }

    return {
      comments: comments.edges.map((edge) =>
        normalizeComment(edge.node, this.resolveAttachmentUrl),
      ),
      hasNextPage: comments.pageInfo.hasNextPage,
      startCursor: comments.pageInfo.startCursor || "",
      endCursor: comments.pageInfo.endCursor || "",
    };
  }

  // pool every 30s
  async listCommentChanges({
    after,
    signal,
  }: {
    after?: string;
    signal?: AbortSignal;
  }): Promise<DocCommentChangeListResult> {
    const graphql = this.graphqlService;
    if (!graphql) {
      throw new Error("GraphQL service not found");
    }

    const response = await graphql.gql({
      query: listCommentChangesQuery,
      variables: {
        pagination: {
          after,
        },
        workspaceId: this.currentWorkspaceId,
        docId: this.props.docId,
      },
      context: { signal },
    });

    const commentChanges = response.workspace?.commentChanges;
    if (!commentChanges) {
      return {
        changes: [],
        startCursor: "",
        endCursor: after ?? "",
        hasNextPage: false,
      };
    }

    return {
      changes: commentChanges.edges.map((edge) => ({
        id: edge.node.id,
        action: edge.node.action,
        comment: normalizeComment(edge.node.item, this.resolveAttachmentUrl),
        commentId: edge.node.commentId || undefined,
      })),
      startCursor: commentChanges.pageInfo.startCursor || "",
      endCursor: commentChanges.pageInfo.endCursor || "",
      hasNextPage: commentChanges.pageInfo.hasNextPage,
    };
  }

  async createComment(commentInput: {
    content: DocCommentContent;
    mentions?: string[];
  }): Promise<DocComment> {
    const graphql = this.graphqlService;
    if (!graphql) {
      throw new Error("GraphQL service not found");
    }

    const response = await graphql.gql({
      query: createCommentMutation,
      variables: {
        input: {
          workspaceId: this.currentWorkspaceId,
          docId: this.props.docId,
          content: normalizeContent(
            commentInput.content,
            this.serializeAttachmentUrl,
          ),
        },
      },
    });

    const comment = response.createComment;
    return normalizeComment(comment, this.resolveAttachmentUrl);
  }

  async updateComment(
    commentId: string,
    commentInput: {
      content: DocCommentContent;
    },
  ): Promise<void> {
    const graphql = this.graphqlService;
    if (!graphql) {
      throw new Error("GraphQL service not found");
    }

    await graphql.gql({
      query: updateCommentMutation,
      variables: {
        input: {
          id: commentId,
          content: normalizeContent(
            commentInput.content,
            this.serializeAttachmentUrl,
          ),
        },
      },
    });
  }

  async resolveComment(commentId: string, resolved = true): Promise<boolean> {
    const graphql = this.graphqlService;
    if (!graphql) {
      throw new Error("GraphQL service not found");
    }

    const response = await graphql.gql({
      query: resolveCommentMutation,
      variables: {
        input: {
          id: commentId,
          resolved,
        },
      },
    });

    return response.resolveComment;
  }

  async deleteComment(commentId: string): Promise<boolean> {
    const graphql = this.graphqlService;
    if (!graphql) {
      throw new Error("GraphQL service not found");
    }

    const response = await graphql.gql({
      query: deleteCommentMutation,
      variables: {
        id: commentId,
      },
    });
    return response.deleteComment;
  }

  async createReply(
    commentId: string,
    replyInput: {
      content: DocCommentContent;
      mentions?: string[];
    },
  ): Promise<DocCommentReply> {
    const graphql = this.graphqlService;
    if (!graphql) {
      throw new Error("GraphQL service not found");
    }

    const response = await graphql.gql({
      query: createReplyMutation,
      variables: {
        input: {
          commentId,
          content: normalizeContent(
            replyInput.content,
            this.serializeAttachmentUrl,
          ),
        },
      },
    });
    return normalizeReply(response.createReply, this.resolveAttachmentUrl);
  }

  async updateReply(
    replyId: string,
    replyInput: {
      content: DocCommentContent;
    },
  ): Promise<void> {
    const graphql = this.graphqlService;
    if (!graphql) {
      throw new Error("GraphQL service not found");
    }

    await graphql.gql({
      query: updateReplyMutation,
      variables: {
        input: {
          id: replyId,
          content: normalizeContent(
            replyInput.content,
            this.serializeAttachmentUrl,
          ),
        },
      },
    });
  }

  async deleteReply(replyId: string): Promise<void> {
    const graphql = this.graphqlService;
    if (!graphql) {
      throw new Error("GraphQL service not found");
    }

    await graphql.gql({
      query: deleteReplyMutation,
      variables: {
        id: replyId,
      },
    });
  }

  /**
   * Upload a comment attachment blob and obtain the remote URL.
   * @param file File (image/blob) selected by user
   * @returns Authenticated download URL on the workspace server, resolved from its storage key.
   */
  uploadCommentAttachment = async (file: File): Promise<string> => {
    const graphql = this.graphqlService;
    if (!graphql) {
      throw new Error("GraphQL service not found");
    }

    const res = await graphql.gql({
      timeout: 180_000,
      query: uploadCommentAttachmentMutation,
      variables: {
        workspaceId: this.currentWorkspaceId,
        docId: this.props.docId,
        attachment: file,
      },
    });
    return this.resolveAttachmentUrl(res.uploadCommentAttachment);
  };
}
