// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  AlertTriangleIcon,
  CalendarClockIcon,
  PencilIcon,
  RefreshCwIcon,
} from "@myoxus/icons/lit";
import type { EventBlockModel } from "@virgultum/model";
import {
  EditorI18nProvider,
  type EditorI18nMessage,
  editorMessage,
  hasCapability,
  MyoxusHostCapability,
  MyoxusHostServiceIdentifier,
  type MyoxusResolvedEvent,
  resolveEditorMessage,
} from "@virgultum/shared/services";
import { BlockComponent } from "@virgultum/std";
import { css, html, nothing } from "lit";
import { state } from "lit/decorators.js";

type EventBlockState = "loading" | "ready" | "unavailable";

export class EventBlockComponent extends BlockComponent<EventBlockModel> {
  static override styles = css`
    :host {
      display: block;
      margin-block: var(--mantine-spacing-2xs);
    }

    .event-card {
      position: relative;
      display: flex;
      align-items: center;
      box-sizing: border-box;
      width: 100%;
      min-width: 0;
      gap: var(--mantine-spacing-sm);
      padding: var(--mantine-spacing-sm) var(--mantine-spacing-md);
      overflow: hidden;
      border: 1px solid var(--myoxus-border-color);
      border-radius: var(--mantine-radius-md);
      background: var(--myoxus-background-secondary-color);
      color: var(--myoxus-text-primary-color);
      font-family: var(--myoxus-font-family);
      text-align: start;
    }

    button.event-card {
      appearance: none;
      cursor: pointer;
    }

    button.event-card:hover {
      background: var(--myoxus-hover-color);
    }

    button.event-card:focus-visible {
      outline: var(--mantine-spacing-2xs) solid var(--myoxus-primary-color);
      outline-offset: var(--mantine-spacing-2xs);
    }

    .event-card::before {
      position: absolute;
      inset-block: 0;
      inset-inline-start: 0;
      width: var(--mantine-spacing-2xs);
      content: "";
      background: var(--myoxus-event-accent, var(--myoxus-primary-color));
    }

    .event-card[data-state="unavailable"]::before {
      background: var(--myoxus-error-color);
    }

    .event-icon,
    .event-action {
      display: inline-flex;
      flex: 0 0 auto;
      align-items: center;
      justify-content: center;
      color: var(--myoxus-text-secondary-color);
    }

    .event-icon svg,
    .event-action svg {
      width: var(--mantine-spacing-lg);
      height: var(--mantine-spacing-lg);
    }

    .event-card[data-state="unavailable"] .event-icon {
      color: var(--myoxus-error-color);
    }

    .event-content {
      display: flex;
      min-width: 0;
      flex: 1;
      flex-direction: column;
      gap: var(--mantine-spacing-2xs);
    }

    .event-title,
    .event-meta {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .event-title {
      font-size: var(--myoxus-font-base);
      font-style: var(--myoxus-typography-body-font-style);
      font-weight: var(--myoxus-typography-body-weight);
      line-height: var(--myoxus-line-height);
    }

    .event-meta {
      color: var(--myoxus-text-secondary-color);
      font-size: var(--myoxus-font-sm);
      font-style: var(--myoxus-typography-body-small-font-style);
      font-weight: var(--myoxus-typography-body-small-weight);
      line-height: var(--myoxus-typography-body-small-line-height);
    }

    .event-card[data-state="loading"] .event-title,
    .event-card[data-state="loading"] .event-icon {
      opacity: 0.64;
    }

    .event-action {
      opacity: 0;
    }

    button.event-card:hover .event-action,
    button.event-card:focus-visible .event-action,
    .event-card[data-state="unavailable"] .event-action {
      opacity: 1;
    }
  `;

  @state()
  private accessor _event: MyoxusResolvedEvent | null = null;

  @state()
  private accessor _state: EventBlockState = "loading";

  private _loadedEventId = "";
  private _requestSerial = 0;

  override connectedCallback() {
    super.connectedCallback();
    this.contentEditable = "false";
    this._loadedEventId = this.model.props.eventId ?? "";
    void this._loadEvent();
    this.bindHotKey({
      Delete: () => {
        if (this.store.readonly) return false;
        void this._requestDelete();
        return true;
      },
      Backspace: () => {
        if (this.store.readonly) return false;
        void this._requestDelete();
        return true;
      },
    });
  }

  override updated(changedProperties: Map<string | number | symbol, unknown>) {
    super.updated(changedProperties);
    const currentId = this.model.props.eventId ?? "";
    if (currentId !== this._loadedEventId) {
      this._loadedEventId = currentId;
      void this._loadEvent();
    }
  }

  private _text(message: EditorI18nMessage) {
    const i18n = this.std.getOptional(EditorI18nProvider) ?? undefined;
    return resolveEditorMessage(message, i18n);
  }

  private async _requestDelete(): Promise<void> {
    if (this.store.readonly) return;
    const { eventId, workspaceId } = this.model.props;
    const host = this.std.getOptional(MyoxusHostServiceIdentifier);
    if (
      !host ||
      !hasCapability(host, MyoxusHostCapability.ConfirmEventBlockRemoval) ||
      !host.confirmEventBlockRemoval
    ) {
      this.store.deleteBlock(this.model);
      return;
    }
    try {
      const confirmed = await host.confirmEventBlockRemoval({
        blockId: this.blockId,
        eventId,
        workspaceId,
      });
      if (confirmed) this.store.deleteBlock(this.model);
    } catch (error) {
      console.warn("[event-block] removal confirmation failed", { error });
    }
  }

  private async _loadEvent(): Promise<void> {
    const serial = ++this._requestSerial;
    const { eventId, workspaceId } = this.model.props;
    this._state = "loading";
    this._event = null;

    const host = this.std.getOptional(MyoxusHostServiceIdentifier);
    if (
      !eventId ||
      !workspaceId ||
      !host ||
      !hasCapability(host, MyoxusHostCapability.ResolveEventData)
    ) {
      this._state = "unavailable";
      return;
    }

    try {
      const event = await host.resolveEventData({ eventId, workspaceId });
      if (serial !== this._requestSerial) return;
      this._event = event;
      this._state = event ? "ready" : "unavailable";
    } catch (error) {
      if (serial !== this._requestSerial) return;
      console.warn("[event-block] event resolution failed", { eventId, error });
      this._state = "unavailable";
    }
  }

  private async _activate(): Promise<void> {
    if (this._state === "loading") return;
    if (this._state === "unavailable") {
      await this._loadEvent();
      return;
    }
    if (this.store.readonly) return;

    const { eventId, workspaceId } = this.model.props;
    const host = this.std.getOptional(MyoxusHostServiceIdentifier);
    if (
      !host ||
      !hasCapability(host, MyoxusHostCapability.OpenEventEditDialog)
    ) {
      return;
    }
    try {
      const savedEventId = await host.openEventEditDialog({
        eventId,
        workspaceId,
        sourceDocId: this.store.id,
      });
      if (savedEventId) await this._loadEvent();
    } catch (error) {
      console.warn("[event-block] event dialog failed", { eventId, error });
    }
  }

  private _formatDateRange(event: MyoxusResolvedEvent): string {
    if (!event.startsAt) return "";
    const start = new Date(event.startsAt);
    const end = event.endsAt ? new Date(event.endsAt) : null;
    if (Number.isNaN(start.valueOf())) return "";

    const i18n = this.std.getOptional(EditorI18nProvider) ?? undefined;
    const locale = i18n?.locale$.value;
    const date = new Intl.DateTimeFormat(locale, {
      weekday: "short",
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
    const time = new Intl.DateTimeFormat(locale, {
      hour: "2-digit",
      minute: "2-digit",
    });
    const sameDay =
      end &&
      start.getFullYear() === end.getFullYear() &&
      start.getMonth() === end.getMonth() &&
      start.getDate() === end.getDate();

    if (event.allDay) {
      const range =
        end && !sameDay
          ? `${date.format(start)} – ${date.format(end)}`
          : date.format(start);
      return `${range} · ${this._text(
        editorMessage("com.myoxus.integration.calendar.all-day", "All day"),
      )}`;
    }
    if (!end || Number.isNaN(end.valueOf())) {
      return `${date.format(start)} · ${time.format(start)}`;
    }
    if (sameDay) {
      return `${date.format(start)} · ${time.format(start)}–${time.format(end)}`;
    }
    return `${date.format(start)} ${time.format(start)} – ${date.format(end)} ${time.format(end)}`;
  }

  private _accentStyle() {
    const color = this._event?.tagColor?.trim();
    return color && globalThis.CSS?.supports("color", color)
      ? `--myoxus-event-accent: ${color}`
      : nothing;
  }

  private _content() {
    const loading = this._state === "loading";
    const unavailable = this._state === "unavailable";
    const title = loading
      ? this._text(editorMessage("Loading", "Loading…"))
      : unavailable
        ? this._text(
            editorMessage(
              "com.myoxus.editor.event.unavailable",
              "Event unavailable",
            ),
          )
        : this._event?.title ||
          this._text(
            editorMessage(
              "com.myoxus.integration.calendar.untitled-event",
              "Untitled event",
            ),
          );
    const meta = unavailable
      ? this._text(editorMessage("Retry", "Retry"))
      : this._event
        ? this._formatDateRange(this._event)
        : "";
    return html`
      <span class="event-icon" aria-hidden="true">
        ${unavailable ? AlertTriangleIcon() : CalendarClockIcon()}
      </span>
      <span class="event-content">
        <span class="event-title">${title}</span>
        ${meta ? html`<span class="event-meta">${meta}</span>` : nothing}
      </span>
      <span class="event-action" aria-hidden="true">
        ${unavailable ? RefreshCwIcon() : PencilIcon()}
      </span>
    `;
  }

  override renderBlock() {
    const title =
      this._event?.title ||
      this._text(
        editorMessage(
          "com.myoxus.integration.calendar.untitled-event",
          "Untitled event",
        ),
      );
    const label =
      this._state === "loading"
        ? this._text(editorMessage("Loading", "Loading…"))
        : this._state === "unavailable"
          ? this._text(editorMessage("Retry", "Retry"))
          : `${this._text(
              editorMessage(
                "com.myoxus.integration.calendar.event-edit",
                "Edit event",
              ),
            )}: ${title}`;
    if (this.store.readonly) {
      return html`
        <div
          class="event-card"
          data-state=${this._state}
          style=${this._accentStyle()}
          role="group"
          aria-label=${label}
        >
          ${this._content()}
        </div>
      `;
    }
    return html`
      <button
        class="event-card"
        type="button"
        data-state=${this._state}
        style=${this._accentStyle()}
        aria-busy=${this._state === "loading" ? "true" : "false"}
        aria-label=${label}
        @click=${this._activate}
      >
        ${this._content()}
      </button>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-event": EventBlockComponent;
  }
}
