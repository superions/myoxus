// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

/**
 * Scoped Typography editor for the server-owned Theme DB.
 *
 * The same component is used for the global Design/Typography surface and for
 * workspace overrides. The only difference is the optional `workspaceId` sent
 * to AdminRoot; all validation, clone-on-write and PDF-role checks stay on the
 * server instead of being duplicated in the frontend.
 */
import { useI18n } from "@myoxus/i18n";
import {
  AlignLeftIcon,
  Heading1Icon,
  LinkIcon,
  Settings2Icon,
  SparklesIcon,
  TextTypeIcon,
  TypeIcon,
} from "@myoxus/icons/react";
import {
  Button,
  ErrorMessage,
  Group,
  SettingsHeadingGroup,
  SettingsNotice,
  SettingsSectionHeading,
  SettingsSectionDescription,
  Stack,
  StatusDot,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@myoxus/ui-facade";
import { useMemo, useRef, useState } from "react";

import { AdminPageScroll, AdminSubnav } from "../admin-shell";
import {
  useEffectiveThemeProfileQuery,
  useSetTypographyStylesMutation,
  useThemeCatalogQuery,
} from "../theme/theme-api";
import { styleByKey } from "../theme/theme-contract";
import {
  type BlockquoteToken,
  type BodyToken,
  type HierarchyToken,
  type HierarchyTokenKey,
  type LinkToken,
  type MonoToken,
  readTypographyTokensFromTheme,
  rebaseTypographyDraftTokens,
  typographyStylePatchesFromTokens,
  type TypographyTokens,
  typographyTokensEqual,
} from "./api";
import { BodyTab } from "./body-tab";
import { EditorFontsTab } from "./editor-fonts-tab";
import { FontLibraryTab } from "./font-library-tab";
import { HierarchyTab } from "./hierarchy-tab";
import { InlineTab } from "./inline-tab";
import { PresetsTab } from "./presets-tab";
import { PreviewPane } from "./preview-pane";
import { StylesTab } from "./styles-tab";

const EDITING_TABS = [
  { value: "hierarchy", icon: Heading1Icon, key: "hierarchy" },
  { value: "body", icon: AlignLeftIcon, key: "body" },
  { value: "inline", icon: LinkIcon, key: "inline" },
  { value: "styles", icon: Settings2Icon, key: "styles" },
  { value: "presets", icon: SparklesIcon, key: "presets" },
] as const;

const GLOBAL_TABS = [
  { value: "font-library", icon: TextTypeIcon, key: "font-library" },
  { value: "editor-fonts", icon: TypeIcon, key: "editor-fonts" },
  ...EDITING_TABS,
] as const;

export const TYPOGRAPHY_TAB_IDS = GLOBAL_TABS.map((tab) => tab.value);
export type TypographyTabId = (typeof TYPOGRAPHY_TAB_IDS)[number];

const DRAFT_TOKEN_TAB_IDS = ["hierarchy", "body", "inline"] as const;

function isDraftTokenTab(tab: string) {
  return (DRAFT_TOKEN_TAB_IDS as readonly string[]).includes(tab);
}

type TypographyEditorLayout = "page" | "embedded";

type ScopedTypographyEditorProps = {
  workspaceId?: string | null;
  layout?: TypographyEditorLayout;
  activeTab?: TypographyTabId;
  onActiveTabChange?: (next: string) => void;
  title?: string;
  description?: string;
  notice?: string;
  testId?: string;
  onSaveStart?: () => boolean;
  onSaveEnd?: () => void;
};

export type TypographyNumberDrafts = Record<string, string>;
export type TypographyNumberChange = (
  id: string,
  value: string | number,
  commit: (value: number) => void,
) => void;

export function ScopedTypographyEditor(props: ScopedTypographyEditorProps) {
  // A retained workspace panel must never write another workspace's draft.
  return (
    <ScopedTypographyEditorContent
      key={props.workspaceId ?? "global"}
      {...props}
    />
  );
}

function ScopedTypographyEditorContent({
  workspaceId = null,
  layout = "page",
  activeTab,
  onActiveTabChange,
  title,
  description,
  notice,
  testId,
  onSaveStart,
  onSaveEnd,
}: ScopedTypographyEditorProps) {
  const i18n = useI18n();
  const [localActiveTab, setLocalActiveTab] =
    useState<TypographyTabId>("hierarchy");
  const { themes, fontFamilies } = useThemeCatalogQuery();
  const { profile } = useEffectiveThemeProfileQuery(workspaceId);
  const { setTypographyStyles, isMutating } = useSetTypographyStylesMutation();
  const [baselineTokens, setBaselineTokens] = useState<TypographyTokens | null>(
    null,
  );
  const [draftTokens, setDraftTokens] = useState<TypographyTokens | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [numberDrafts, setNumberDrafts] = useState<TypographyNumberDrafts>({});
  const [isSaving, setIsSaving] = useState(false);
  const saveLock = useRef(false);
  const editorRef = useRef<HTMLDivElement>(null);

  const activeTheme =
    profile?.theme ??
    themes.find((theme) => theme.isDefault) ??
    themes[0] ??
    null;
  const tokens: TypographyTokens = useMemo(
    () => readTypographyTokensFromTheme(activeTheme, fontFamilies),
    [activeTheme, fontFamilies],
  );
  const codeBlockStyle = styleByKey(activeTheme, ["code.block"]);

  const incomingVersion = JSON.stringify({
    theme: activeTheme?.slug,
    typography: activeTheme?.typographySlug,
    tokens,
  });
  const [serverVersion, setServerVersion] = useState(incomingVersion);
  // Native hidden tabs reconnect effects. Rebase on changed server values,
  // not on effect activation or fresh catalog object identities.
  if (serverVersion !== incomingVersion) {
    setServerVersion(incomingVersion);
    setBaselineTokens(tokens);
    setDraftTokens(
      rebaseTypographyDraftTokens(
        baselineTokens ?? tokens,
        draftTokens ?? tokens,
        tokens,
      ),
    );
  }

  const baseTokens = baselineTokens ?? tokens;
  const effectiveTokens = draftTokens ?? tokens;
  const invalidNumber = Object.keys(numberDrafts).length > 0;
  const dirty =
    invalidNumber || !typographyTokensEqual(baseTokens, effectiveTokens);
  const busy = isMutating || isSaving;
  const canEdit = Boolean(activeTheme) && fontFamilies.length > 0;
  const isEmbedded = layout === "embedded";
  const scopeWorkspaceId = workspaceId ?? null;
  const activeTabs = isEmbedded ? EDITING_TABS : GLOBAL_TABS;
  const activeTabIds = activeTabs.map((tab) => tab.value);
  const requestedTab = activeTab ?? localActiveTab;
  const currentTab = (activeTabIds as readonly string[]).includes(requestedTab)
    ? requestedTab
    : "hierarchy";
  const showDraftChrome = isDraftTokenTab(currentTab);

  const setTab = (next: string) => {
    const resolved = (activeTabIds as readonly string[]).includes(next)
      ? (next as TypographyTabId)
      : "hierarchy";
    setLocalActiveTab(resolved);
    onActiveTabChange?.(resolved);
  };

  const updateDraft = (next: TypographyTokens) => {
    setDraftTokens(next);
    setSaved(false);
    setError(null);
  };
  const handleHierarchyChange = (
    key: HierarchyTokenKey,
    next: HierarchyToken,
  ) => {
    updateDraft({ ...effectiveTokens, [key]: next });
  };
  const handleBodyChange = (key: "body" | "bodySmall", next: BodyToken) => {
    updateDraft({ ...effectiveTokens, [key]: next });
  };
  const handleBlockquoteChange = (next: BlockquoteToken) => {
    updateDraft({ ...effectiveTokens, blockquote: next });
  };
  const handleLinkChange = (next: LinkToken) => {
    updateDraft({ ...effectiveTokens, link: next });
  };
  const handleMonoChange = (next: MonoToken) => {
    updateDraft({ ...effectiveTokens, mono: next });
  };
  const handleSave = async () => {
    if (!activeTheme || !canEdit || !dirty || invalidNumber || saveLock.current)
      return;
    if (onSaveStart && !onSaveStart()) return;
    saveLock.current = true;
    setIsSaving(true);
    try {
      const styles = typographyStylePatchesFromTokens(
        activeTheme,
        baseTokens,
        effectiveTokens,
        fontFamilies,
      );
      if (styles.length === 0) {
        throw new Error(i18n.t("admin.typography.save.blocked"));
      }
      const updatedProfile = await setTypographyStyles({
        workspaceId: scopeWorkspaceId,
        styles,
      });
      const savedTokens = readTypographyTokensFromTheme(
        updatedProfile.theme,
        fontFamilies,
      );
      setBaselineTokens(savedTokens);
      setDraftTokens(savedTokens);
      setSaved(true);
      setError(null);
    } catch (err) {
      setSaved(false);
      setError(
        err instanceof Error
          ? err.message
          : i18n.t("admin.typography.failed-save"),
      );
    } finally {
      saveLock.current = false;
      setIsSaving(false);
      onSaveEnd?.();
    }
  };

  const changeNumber: TypographyNumberChange = (id, value, commit) => {
    const parsed = value === "" ? Number.NaN : Number(value);
    setNumberDrafts((current) => {
      const next = { ...current };
      if (Number.isFinite(parsed)) delete next[id];
      else next[id] = String(value);
      return next;
    });
    if (Number.isFinite(parsed)) commit(parsed);
    setSaved(false);
    setError(null);
  };

  const discard = () => {
    setDraftTokens(baseTokens);
    setNumberDrafts({});
    setError(null);
    setSaved(false);
    const firstEditor =
      currentTab === "hierarchy"
        ? "hierarchy-card-h1"
        : currentTab === "body"
          ? "body-card-body"
          : "inline-card-link";
    // Disclosure controls remain focusable even when their fields are collapsed.
    queueMicrotask(() =>
      editorRef.current
        ?.querySelector<HTMLButtonElement>(
          `[data-testid="${firstEditor}"] button[aria-expanded]`,
        )
        ?.focus(),
    );
  };

  const pageSubnavItems = activeTabs.map(({ value, key }) => ({
    value,
    label: i18n.t(`admin.typography.tab.${key}` as never),
    testId: `typography-tab-${key}`,
  }));

  const embeddedNav = (
    <TabsList>
      {activeTabs.map(({ value, icon: Icon, key }) => (
        <TabsTrigger
          key={value}
          value={value}
          data-testid={`typography-tab-${key}`}
        >
          <Icon aria-hidden="true" />
          {i18n.t(`admin.typography.tab.${key}` as never)}
        </TabsTrigger>
      ))}
    </TabsList>
  );

  const draftActions = showDraftChrome ? (
    <Group justify="flex-end">
      {dirty ? (
        <StatusDot tone="warning" label={i18n.t("admin.typography.dirty")} />
      ) : saved ? (
        <StatusDot tone="success" label={i18n.t("admin.state.saved")} />
      ) : null}
      {dirty ? (
        <Button
          type="button"
          variant="secondary"
          disabled={busy}
          onClick={discard}
          data-testid="typography-discard"
        >
          {i18n.t("admin.actions.cancel")}
        </Button>
      ) : null}
      <Button
        type="button"
        variant="primary"
        disabled={!dirty || !canEdit || busy || invalidNumber}
        onClick={handleSave}
        data-testid="typography-save"
      >
        {i18n.t("admin.actions.save")}
      </Button>
    </Group>
  ) : null;

  const editor = (
    <Stack ref={editorRef}>
      {isEmbedded && showDraftChrome && notice ? (
        <SettingsNotice tone="neutral" data-testid="typography-edit-notice">
          {notice}
        </SettingsNotice>
      ) : null}
      {error ? (
        <ErrorMessage role="alert" data-testid="typography-save-error">
          {error}
        </ErrorMessage>
      ) : null}
      {invalidNumber ? (
        <SettingsNotice
          tone="error"
          role="alert"
          data-testid="typography-number-error"
        >
          {i18n.t("admin.typography.styles.validation.failed")}
        </SettingsNotice>
      ) : null}

      {!isEmbedded ? (
        <>
          <TabsContent value="font-library">
            <FontLibraryTab fontFamilies={fontFamilies} />
          </TabsContent>
          <TabsContent value="editor-fonts">
            <EditorFontsTab theme={activeTheme} fontFamilies={fontFamilies} />
          </TabsContent>
        </>
      ) : null}

      <TabsContent value="hierarchy">
        <HierarchyTab
          headingLevel={isEmbedded ? 4 : 2}
          tokens={effectiveTokens}
          fontFamilies={fontFamilies}
          readOnly={!canEdit || busy}
          numberDrafts={numberDrafts}
          onNumberChange={changeNumber}
          onChange={handleHierarchyChange}
          actions={currentTab === "hierarchy" ? draftActions : null}
        />
      </TabsContent>
      <TabsContent value="body">
        <BodyTab
          headingLevel={isEmbedded ? 4 : 2}
          tokens={effectiveTokens}
          codeBlockStyle={codeBlockStyle}
          fontFamilies={fontFamilies}
          readOnly={!canEdit || busy}
          numberDrafts={numberDrafts}
          onNumberChange={changeNumber}
          onChangeBody={handleBodyChange}
          onChangeBlockquote={handleBlockquoteChange}
          actions={currentTab === "body" ? draftActions : null}
        />
      </TabsContent>
      <TabsContent value="inline">
        <InlineTab
          headingLevel={isEmbedded ? 4 : 2}
          tokens={effectiveTokens}
          fontFamilies={fontFamilies}
          readOnly={!canEdit || busy}
          numberDrafts={numberDrafts}
          onNumberChange={changeNumber}
          onChangeLink={handleLinkChange}
          onChangeMono={handleMonoChange}
          actions={currentTab === "inline" ? draftActions : null}
        />
      </TabsContent>
      <TabsContent value="styles">
        <StylesTab
          headingLevel={isEmbedded ? 4 : 2}
          activeTheme={activeTheme}
          fontFamilies={fontFamilies}
          readOnly={!canEdit || busy}
          isSaving={busy}
          onSave={async (styles) => {
            if (saveLock.current)
              throw new Error(i18n.t("admin.typography.save.blocked"));
            if (onSaveStart && !onSaveStart())
              throw new Error(i18n.t("admin.typography.save.blocked"));
            saveLock.current = true;
            setIsSaving(true);
            try {
              const tokenBaselineBeforeSave = baseTokens;
              const tokenDraftBeforeSave = effectiveTokens;
              const updatedProfile = await setTypographyStyles({
                workspaceId: scopeWorkspaceId,
                styles,
              });
              const savedTokens = readTypographyTokensFromTheme(
                updatedProfile.theme,
                fontFamilies,
              );
              setBaselineTokens(savedTokens);
              setDraftTokens(
                typographyTokensEqual(
                  tokenBaselineBeforeSave,
                  tokenDraftBeforeSave,
                )
                  ? savedTokens
                  : rebaseTypographyDraftTokens(
                      tokenBaselineBeforeSave,
                      tokenDraftBeforeSave,
                      savedTokens,
                    ),
              );
              return updatedProfile.theme;
            } finally {
              saveLock.current = false;
              setIsSaving(false);
              onSaveEnd?.();
            }
          }}
        />
      </TabsContent>
      <TabsContent value="presets">
        <PresetsTab
          activeTheme={activeTheme}
          headingLevel={isEmbedded ? 4 : 2}
        />
      </TabsContent>
      {showDraftChrome ? (
        <PreviewPane tokens={effectiveTokens} codeBlockStyle={codeBlockStyle} />
      ) : null}
    </Stack>
  );

  return (
    <Tabs
      value={currentTab}
      onValueChange={setTab}
      layout={isEmbedded ? "embedded" : "page"}
      data-testid={testId}
      variant="default"
    >
      {isEmbedded ? (
        <Stack component="section">
          <SettingsHeadingGroup>
            <SettingsSectionHeading level={3}>
              {title ?? i18n.t("admin.typography.title")}
            </SettingsSectionHeading>
            <SettingsSectionDescription>
              {description ?? i18n.t("admin.typography.hero.description")}
            </SettingsSectionDescription>
          </SettingsHeadingGroup>
          <SettingsHeadingGroup>{embeddedNav}</SettingsHeadingGroup>
          {editor}
        </Stack>
      ) : (
        <>
          <AdminSubnav items={pageSubnavItems} />
          <AdminPageScroll>{editor}</AdminPageScroll>
        </>
      )}
    </Tabs>
  );
}
