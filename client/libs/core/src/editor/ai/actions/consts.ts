export const EXCLUDING_COPY_ACTIONS = [
  "brainstormMindmap",
  "expandMindmap",
  "makeItReal",
  "createSlides",
  "findActions",
];

export const EXCLUDING_REPLACE_ACTIONS = [
  "brainstormMindmap",
  "expandMindmap",
  "makeItReal",
  "createSlides",
];

export const EXCLUDING_INSERT_ACTIONS = ["generateCaption"];

export const generatingStages: {
  [key in keyof Partial<VirgultumPresets.AIActions>]: string[];
} = {
  makeItReal: ["Coding for you", "Rendering the code"],
  brainstormMindmap: ["Thinking about this topic", "Rendering mindmap"],
  createSlides: ["Thinking about this topic", "Rendering slides"],
};

export const INSERT_ABOVE_ACTIONS = ["createHeadings"];
