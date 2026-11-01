const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});
const emojiRe =
  /(\u00a9|\u00ae|[\u2000-\u3300]|\ud83c[\ud000-\udfff]|\ud83d[\ud000-\udfff]|\ud83e[\ud000-\udfff])/g;

/**
 * @deprecated use ExplorerIconService instead
 */
export function extractEmojiIcon(text: string) {
  emojiRe.lastIndex = 0;
  const match = emojiRe.exec(text);
  if (match && match.index === 0) {
    // Preserve the complete leading emoji cluster and UTF-16 slicing offsets.
    // A match at zero guarantees a nonempty first segment.
    const emojiEnd = graphemeSegmenter.segment(text).containing(0)!.segment
      .length;
    return {
      emoji: text.slice(0, emojiEnd),
      rest: text.slice(emojiEnd),
    };
  }
  return {
    emoji: null,
    rest: text,
  };
}
