declare interface BUILD_CONFIG_TYPE {
  debug: boolean;
  distribution: 'web' | 'desktop' | 'admin' | 'mobile' | 'ios' | 'android';
  /**
   * 'web' | 'desktop' | 'admin'
   */
  isDesktopEdition: boolean;
  /**
   * 'mobile'
   */
  isMobileEdition: boolean;

  isElectron: boolean;
  isWeb: boolean;
  /**
   * 'desktop' | 'ios' | 'android'
   */
  isNative: boolean;
  isMobileWeb: boolean;
  isIOS: boolean;
  isAndroid: boolean;
  isAdmin: boolean;

  appVersion: string;
  editorVersion: string;
  appBuildType: 'stable' | 'beta' | 'internal';

  githubUrl: string;
  websiteUrl: string;
  docsUrl: string;
  blogUrl: string;
  communityUrl: string;
  contactUrl: string;
  licenseUrl: string;
  securityUrl: string;
  operatorGuideUrl: string;
  upgradeGuideUrl: string;
  releaseNotesUrl: string;
  changelogUrl: string;
  pricingUrl: string;
  downloadUrl: string;

  requestLicenseUrl: string;
  // see: tools/workers
  imageProxyUrl: string;
  linkPreviewUrl: string;

  SENTRY_DSN: string;
}

declare var BUILD_CONFIG: BUILD_CONFIG_TYPE;
