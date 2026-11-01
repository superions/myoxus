import '@myoxus/env/constant';
import '@virgultum/editor/global/types'

declare module '@virgultum/editor/store' {
  interface DocMeta {
    /**
     * @deprecated
     */
    favorite?: boolean;
    trash?: boolean;
    trashDate?: number;
    updatedDate?: number;
    mode?: 'page' | 'edgeless';
    // todo: support `number` in the future
    isPublic?: boolean;
  }
}


declare global {

declare type Environment = {
  // Variant
  isSelfHosted: boolean;

  // Device
  isLinux: boolean;
  isMacOs: boolean;
  isIOS: boolean;
  isSafari: boolean;
  isWindows: boolean;
  isFireFox: boolean;
  isMobile: boolean;
  isChrome: boolean;
  isPwa: boolean;
  chromeVersion?: number;

  // runtime configs
  publicPath: string;
  subPath: string;
};

  var process: {
    env: Record<string, string>;
  };
  var environment: Environment;
  var $AFFINE_SETUP: boolean | undefined;
  /**
   * Injected by the Sentry bundler plugin during configured production builds.
   */
  var SENTRY_RELEASE: { id: string } | undefined;
}
