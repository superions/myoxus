// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from "node:crypto";
import type { RendererCloseRequest } from "@myoxus/desktop-api-contract";
import type { WebContents } from "electron";
import { uiSubjects } from "./ui/subject";

type Participant = {
  sender: Pick<WebContents, "id" | "isDestroyed" | "once">;
  tokens: Set<string>;
  reveal: () => Promise<void>;
};
type Pending = {
  senderId: number;
  participantId: string;
  finish: (allowed: boolean) => void;
};

/** Main admission runs before destructive cleanup. Only the registering sender
 * can answer its captured participant; timeout, removal and transport failure
 * veto, never silently quit. This is not a save or document-lifecycle owner. */
export class RendererCloseAdmission {
  private readonly participants = new Map<number, Participant>();
  private readonly pending = new Map<string, Pending>();
  private readonly operations = new Map<number | "all", Promise<boolean>>();

  constructor(
    private readonly send: (request: RendererCloseRequest) => void,
    private readonly timeoutMs = 120_000,
  ) {}

  /** Workspace-scoped registration; the renderer unregisters before disposal.
   * Empty renderer records share one listener until WebContents destruction. */
  register(
    sender: Participant["sender"],
    token: string,
    reveal: Participant["reveal"],
  ) {
    if (
      typeof token !== "string" ||
      !token ||
      token.length > 128 ||
      sender.isDestroyed()
    )
      return false;
    let participant = this.participants.get(sender.id);
    if (!participant) {
      participant = { sender, tokens: new Set(), reveal };
      this.participants.set(sender.id, participant);
      sender.once("destroyed", () => {
        if (this.participants.get(sender.id) === participant) {
          this.participants.delete(sender.id);
          this.cancel(sender.id);
        }
      });
    }
    participant.reveal = reveal;
    participant.tokens.add(token);
    return true;
  }

  /** Removal is not consent: any outstanding request for this token is vetoed. */
  unregister(senderId: number, token: string) {
    const participant = this.participants.get(senderId);
    if (!participant?.tokens.delete(token)) return false;
    this.cancel(senderId, token);
    // Retain the renderer record until destruction so repeated workspace mounts
    // share one destroyed listener rather than accumulating listeners per token.
    return true;
  }

  /** False means unmatched/expired, not that another caller may authorize it. */
  answer(
    senderId: number,
    requestId: string,
    participantId: string,
    allowed: boolean,
  ) {
    const pending = this.pending.get(requestId);
    if (
      !pending ||
      pending.senderId !== senderId ||
      pending.participantId !== participantId
    )
      return false;
    pending.finish(allowed === true);
    return true;
  }

  /** One tab asks only its renderer; window/app/relaunch/install ask all. A new
   * participant introduced during the decision was not admitted to disappear. */
  request(senderId?: number): Promise<boolean> {
    const key = senderId ?? "all";
    const current = this.operations.get(key);
    if (current) return current;
    const snapshot = [...this.participants.values()]
      .filter(
        (p) =>
          p.tokens.size && (senderId === undefined || p.sender.id === senderId),
      )
      .map((participant) => ({ participant, tokens: [...participant.tokens] }));
    const operation = (async () => {
      try {
        for (const { participant, tokens } of snapshot) {
          if (participant.sender.isDestroyed()) return false;
          if (!(await this.reveal(participant))) return false;
          for (const token of tokens) {
            if (
              !participant.tokens.has(token) ||
              !(await this.ask(participant.sender.id, token))
            )
              return false;
          }
        }
        const live = [...this.participants.values()].filter(
          (p) =>
            p.tokens.size &&
            (senderId === undefined || p.sender.id === senderId),
        );
        return (
          live.length === snapshot.length &&
          snapshot.every(
            ({ participant, tokens }) =>
              live.includes(participant) &&
              tokens.length === participant.tokens.size &&
              tokens.every((token) => participant.tokens.has(token)),
          )
        );
      } catch {
        return false;
      }
    })();
    this.operations.set(key, operation);
    void operation.finally(() => {
      if (this.operations.get(key) === operation) this.operations.delete(key);
    });
    return operation;
  }

  private reveal(participant: Participant) {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (allowed: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(allowed);
      };
      const timer = setTimeout(() => finish(false), this.timeoutMs);
      void Promise.resolve()
        .then(() => participant.reveal())
        .then(
          () => finish(true),
          () => finish(false),
        );
    });
  }

  private ask(senderId: number, participantId: string) {
    return new Promise<boolean>((resolve) => {
      const requestId = randomUUID();
      const finish = (allowed: boolean) => {
        if (!this.pending.delete(requestId)) return;
        clearTimeout(timer);
        resolve(allowed);
      };
      const timer = setTimeout(() => finish(false), this.timeoutMs);
      this.pending.set(requestId, { senderId, participantId, finish });
      try {
        this.send({ requestId, participantId });
      } catch {
        finish(false);
      }
    });
  }

  private cancel(senderId: number, token?: string) {
    for (const pending of this.pending.values())
      if (
        pending.senderId === senderId &&
        (token === undefined || pending.participantId === token)
      )
        pending.finish(false);
  }
}

export const rendererCloseAdmission = new RendererCloseAdmission((request) =>
  uiSubjects.onCloseRequest$.next(request),
);
