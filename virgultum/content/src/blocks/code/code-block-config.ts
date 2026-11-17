import { ConfigExtensionFactory } from "@virgultum/core/runtime";
import type {
  BundledLanguageInfo,
  ThemeInput,
} from "../../syntax-highlighter/index";

export interface CodeBlockConfig {
  theme?: {
    dark?: ThemeInput;
    light?: ThemeInput;
  };
  langs?: BundledLanguageInfo[];

  /**
   * Whether to show line numbers in the code block.
   * @default true
   */
  showLineNumbers?: boolean;
}

export const CodeBlockConfigExtension =
  ConfigExtensionFactory<CodeBlockConfig>("myoxus:code");
