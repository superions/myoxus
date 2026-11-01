// SPDX-License-Identifier: AGPL-3.0-or-later
import { useI18n } from "@myoxus/i18n";
import type { ReactToLit } from "@myoxus/lit-react";
import {
  Button,
  Group,
  InlineActionButton,
  Menu,
  MenuItem,
  MenuScrollableSection,
  MyoxusText,
  Tooltip,
} from "@myoxus/ui-facade";
import {
  FootnoteReactHostExtension,
  type FootnoteHeaderHostProps,
  type FootnoteInsertionHostProps,
  type FootnoteMarkerHostProps,
} from "@virgultum/editor/shared/services";
import { useRef } from "react";
import { ArrowLeftIcon, MoreHorizontalIcon, TrashIcon } from "@myoxus/icons";

function FootnoteInsertion({
  placement,
  definitions,
  choose,
  cancel,
}: FootnoteInsertionHostProps) {
  const t = useI18n();
  const chosen = useRef(false);
  return (
    <Menu
      rootOptions={{
        defaultOpen: true,
        onClose: () => {
          if (!chosen.current) cancel();
        },
      }}
      items={
        <MenuScrollableSection>
          <MenuItem
            onSelect={() => {
              chosen.current = true;
              choose();
            }}
          >
            {placement === "endnote"
              ? t["com.myoxus.editor.endnote.new"]()
              : t["com.myoxus.editor.footnote.new"]()}
          </MenuItem>
          {definitions.map((definition) => (
            <MenuItem
              key={definition.id}
              onSelect={() => {
                chosen.current = true;
                choose(definition.id);
              }}
            >
              {noteName(t, definition.placement, definition.number)}
              {definition.excerpt && (
                <MyoxusText>{definition.excerpt}</MyoxusText>
              )}
            </MenuItem>
          ))}
        </MenuScrollableSection>
      }
    >
      <Button>
        {placement === "endnote"
          ? t["com.myoxus.editor.endnote"]()
          : t["com.myoxus.editor.footnote"]()}
      </Button>
    </Menu>
  );
}
function noteName(
  t: ReturnType<typeof useI18n>,
  placement: FootnoteHeaderHostProps["placement"],
  number?: number,
) {
  if (!placement) return t["com.myoxus.editor.note.missing"]();
  if (number === undefined)
    return placement === "endnote"
      ? t["com.myoxus.editor.endnote.unreferenced"]()
      : t["com.myoxus.editor.footnote.unreferenced"]();
  const label = new Intl.NumberFormat(t.language).format(number);
  return placement === "endnote"
    ? t["com.myoxus.editor.endnote.reference"]({ label })
    : t["com.myoxus.editor.footnote.reference"]({ label });
}
function FootnoteMarker({
  label,
  placement,
  number,
  missing,
  navigate,
}: FootnoteMarkerHostProps) {
  const t = useI18n();
  const name =
    label !== undefined
      ? t["com.myoxus.editor.footnote.reference"]({ label })
      : missing
        ? t["com.myoxus.editor.note.missing"]()
        : noteName(t, placement, number);
  return (
    <Tooltip content={name}>
      <InlineActionButton
        aria-label={name}
        data-footnote-missing={missing || undefined}
        onClick={navigate}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            event.stopPropagation();
            navigate();
          }
        }}
      >
        {label ??
          (number === undefined
            ? "[?]"
            : `[${new Intl.NumberFormat(t.language).format(number)}]`)}
      </InlineActionButton>
    </Tooltip>
  );
}
function FootnoteHeader({
  titleId,
  placement,
  number,
  readonly,
  canReturn,
  returnToMarker,
  remove,
  changePlacement,
}: FootnoteHeaderHostProps) {
  const t = useI18n();
  return (
    <Group onKeyDown={(event) => event.stopPropagation()}>
      <MyoxusText id={titleId}>{noteName(t, placement, number)}</MyoxusText>
      <Tooltip content={t["com.myoxus.editor.footnote.return"]()}>
        <InlineActionButton
          aria-label={t["com.myoxus.editor.footnote.return"]()}
          disabled={!canReturn}
          onClick={returnToMarker}
        >
          <ArrowLeftIcon />
        </InlineActionButton>
      </Tooltip>
      {!readonly && (
        <Menu
          items={
            <>
              <MenuItem
                checked={placement === "footnote"}
                onSelect={() => changePlacement("footnote")}
              >
                {t["com.myoxus.editor.footnote"]()}
              </MenuItem>
              <MenuItem
                checked={placement === "endnote"}
                onSelect={() => changePlacement("endnote")}
              >
                {t["com.myoxus.editor.endnote"]()}
              </MenuItem>
              <MenuItem
                type="danger"
                prefixIcon={<TrashIcon />}
                onSelect={remove}
              >
                {t["com.myoxus.editor.note.delete"]()}
              </MenuItem>
            </>
          }
        >
          <InlineActionButton
            aria-label={t["com.myoxus.editor.toolbar.more"]()}
          >
            <MoreHorizontalIcon />
          </InlineActionButton>
        </Menu>
      )}
    </Group>
  );
}
export function patchFootnoteHost(reactToLit: ReactToLit) {
  return FootnoteReactHostExtension({
    renderInsertion: (props) =>
      reactToLit(<FootnoteInsertion {...props} />, true),
    renderMarker: (props) => reactToLit(<FootnoteMarker {...props} />, true),
    renderHeader: (props) => reactToLit(<FootnoteHeader {...props} />, true),
  });
}
