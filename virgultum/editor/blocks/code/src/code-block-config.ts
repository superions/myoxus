import { ConfigExtensionFactory } from "@virgultum/std";
import type {
  BundledLanguageInfo,
  ThemeInput,
} from "@virgultum/components/syntax-highlighter";

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
