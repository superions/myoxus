import { EdgelessClipboardConfig } from "@virgultum/block-surface";
import { type BlockSnapshot } from "@virgultum/store";

export class EdgelessClipboardEmbedGithubConfig extends EdgelessClipboardConfig {
  static override readonly key = "myoxus:embed-github";

  override createBlock(githubEmbed: BlockSnapshot): string | null {
    if (!this.surface) return null;

    const {
      xywh,
      style,
      owner,
      repo,
      githubType,
      githubId,
      url,
      caption,
      image,
      status,
      statusReason,
      title,
      description,
      createdAt,
      assignees,
    } = githubEmbed.props;

    const embedGithubId = this.crud.addBlock(
      "myoxus:embed-github",
      {
        xywh,
        style,
        owner,
        repo,
        githubType,
        githubId,
        url,
        caption,
        image,
        status,
        statusReason,
        title,
        description,
        createdAt,
        assignees,
      },
      this.surface.model.id,
    );
    return embedGithubId;
  }
}
