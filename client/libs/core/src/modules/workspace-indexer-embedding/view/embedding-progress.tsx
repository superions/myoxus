import { useI18n } from "@myoxus/i18n";
import {
  Group,
  MyoxusText,
  type MyoxusTextTone,
  Progress,
  Stack,
} from "@myoxus/ui-facade";

interface EmbeddingProgressProps {
  status: {
    embedded: number;
    total: number;
  } | null;
}

const EmbeddingProgress: React.FC<EmbeddingProgressProps> = ({ status }) => {
  const t = useI18n();

  const loading = status === null;

  const percent = loading
    ? 0
    : status.total === 0
      ? 1
      : status.embedded / status.total;
  const progress = Math.round(percent * 100);
  const synced = percent === 1;
  const progressState = loading ? "loading" : synced ? "synced" : "syncing";
  const titleTone: MyoxusTextTone = loading
    ? "secondary"
    : synced
      ? "success"
      : "primary";
  const title = loading
    ? t[
        "com.myoxus.settings.workspace.indexer-embedding.embedding.progress.loading-sync-status"
      ]()
    : synced
      ? t[
          "com.myoxus.settings.workspace.indexer-embedding.embedding.progress.synced"
        ]()
      : t[
          "com.myoxus.settings.workspace.indexer-embedding.embedding.progress.syncing"
        ]();

  return (
    <Stack
      data-testid="embedding-progress-wrapper"
      data-myoxus-ui-role="workspace-embedding-progress"
      gap="sm"
    >
      <Group
        justify="space-between"
        gap="sm"
        miw={0}
        wrap="nowrap"
        data-testid="embedding-progress-title"
        data-progress={progressState}
      >
        <MyoxusText
          data-myoxus-ui-role="workspace-embedding-progress-title"
          tone={titleTone}
          typographySlot="body-small"
          truncate
        >
          {title}
        </MyoxusText>
        {loading ? null : (
          <MyoxusText
            component="span"
            data-myoxus-ui-role="workspace-embedding-progress-count"
            data-testid="embedding-progress-count"
            flexShrink={0}
            tone="secondary"
            typographySlot="body-small"
          >{`${status.embedded}/${status.total}`}</MyoxusText>
        )}
      </Group>
      {loading ? null : (
        <Progress testId="embedding-progress" value={progress} />
      )}
    </Stack>
  );
};

export default EmbeddingProgress;
