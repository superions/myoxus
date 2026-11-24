import { cssVar } from "@myoxus/theme";

/**
 * You should add a container before the scrollbar style to prevent the style pollution of the whole doc.
 */
export const scrollbarStyle = (container: string) => {
  if (!container) {
    console.error(
      "To prevent style pollution of the whole doc, you must add a container before the scrollbar style.",
    );
    return "";
  }

  // sanitize container name
  if (container.includes("{") || container.includes("}")) {
    console.error("Invalid container name! Please use a valid CSS selector.");
    return "";
  }

  return `
    ${container} {
      scrollbar-gutter: stable;
    }
    ${container}::-webkit-scrollbar {
      -webkit-appearance: none;
      width: var(--mantine-spacing-xs);
      height: var(--mantine-spacing-xs);
    }
    ${container}::-webkit-scrollbar-thumb {
      border-radius: var(--mantine-radius-xs);
      background-color: ${cssVar("iconSecondary")};
    }
    ${container}::-webkit-scrollbar-corner {
      display: none;
    }
  `;
};
