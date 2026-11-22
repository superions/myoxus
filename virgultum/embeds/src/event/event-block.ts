// SPDX-License-Identifier: AGPL-3.0-or-later

import type { EventBlockModel } from "@virgultum/core/models";
import {
  EditorChromeHostIdentifier,
  EditorI18nProvider,
  type EditorI18nMessage,
  editorMessage,
  eventCardDateRange,
  hasCapability,
  MyoxusHostCapability,
  MyoxusHostServiceIdentifier,
  type MyoxusResolvedEvent,
  resolveEditorMessage,
} from "@virgultum/core/services";
import { BlockComponent } from "@virgultum/core/runtime";
import { state } from "lit/decorators.js";

type EventBlockState = "loading" | "ready" | "unavailable";

export class EventBlockComponent extends BlockComponent<EventBlockModel> {
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
    const i18n = this.std.getOptional(EditorI18nProvider) ?? undefined;
    return eventCardDateRange(
      event,
      i18n?.locale$.value,
      this._text(
        editorMessage("com.myoxus.integration.calendar.all-day", "All day"),
      ),
    );
  }

  override renderBlock() {
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
    const eventTitle =
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
            )}: ${eventTitle}`;
    const color = this._event?.tagColor?.trim();
    return this.std.get(EditorChromeHostIdentifier).renderEventCard({
      state: this._state,
      readonly: this.store.readonly,
      title,
      meta,
      label,
      // Authored tag colors are document data; the Facade owns their visual slot.
      accent: color && globalThis.CSS?.supports("color", color) ? color : null,
      activate: () => {
        void this._activate();
      },
    });
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-event": EventBlockComponent;
  }
}
