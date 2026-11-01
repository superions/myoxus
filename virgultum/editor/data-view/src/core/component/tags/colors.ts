import { cssVar } from "@myoxus/theme";

export type SelectOptionColor = {
  oldColor: string;
  color: string;
  name: string;
};
export const selectOptionColors: SelectOptionColor[] = [
  {
    oldColor: "var(--myoxus-tag-red)",
    color: cssVar("tagRed"),
    name: "Red",
  },
  {
    oldColor: "var(--myoxus-tag-pink)",
    color: cssVar("tagMagenta"),
    name: "Magenta",
  },
  {
    oldColor: "var(--myoxus-tag-orange)",
    color: cssVar("tagOrange"),
    name: "Orange",
  },
  {
    oldColor: "var(--myoxus-tag-yellow)",
    color: cssVar("tagYellow"),
    name: "Yellow",
  },
  {
    oldColor: "var(--myoxus-tag-green)",
    color: cssVar("tagGreen"),
    name: "Green",
  },
  {
    oldColor: "var(--myoxus-tag-teal)",
    color: cssVar("tagTeal"),
    name: "Teal",
  },
  {
    oldColor: "var(--myoxus-tag-blue)",
    color: cssVar("tagBlue"),
    name: "Blue",
  },
  {
    oldColor: "var(--myoxus-tag-purple)",
    color: cssVar("tagPurple"),
    name: "Purple",
  },
  {
    oldColor: "var(--myoxus-tag-gray)",
    color: cssVar("tagGray"),
    name: "Grey",
  },
  {
    oldColor: "var(--myoxus-tag-white)",
    color: cssVar("tagWhite"),
    name: "White",
  },
];

const oldColorMap = Object.fromEntries(
  selectOptionColors.map((tag) => [tag.oldColor, tag.color]),
);

export const getColorByColor = (color: string) => {
  if (color.startsWith("--myoxus-tag")) {
    return oldColorMap[color] ?? color;
  }
  return color;
};

/** select tag color poll */
const selectTagColorPoll = selectOptionColors.map((color) => color.color);

function tagColorHelper() {
  let colors = [...selectTagColorPoll];
  return (): string => {
    if (colors.length === 0) {
      colors = [...selectTagColorPoll];
    }
    const index = Math.floor(Math.random() * colors.length);
    const color = colors.splice(index, 1)[0];
    if (!color) return "";
    return color;
  };
}

export const getTagColor = tagColorHelper();
