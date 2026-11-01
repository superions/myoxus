export const QuickSearchTagIcon = ({ color }: { color: string }) => {
  return (
    <span
      aria-hidden="true"
      data-myoxus-ui-role="quicksearch-tag-color-dot"
      style={{
        aspectRatio: "1",
        background: color,
        borderRadius: "50%",
        display: "inline-block",
        width: "0.5em",
      }}
    />
  );
};
