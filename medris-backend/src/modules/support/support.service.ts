import type { DataContext, Identity } from "../../database/context.js";
import { SupportRequestsRepository } from "../../database/repositories/support-requests.repository.js";
import { badRequest, notFound } from "../../shared/errors/app-error.js";

export interface SupportAttachment {
  path: string;
  name: string;
  type: string;
  size: number;
}

/** Support requests (users ask, admins answer). Runs as the user, so row-level security still decides. */
export class SupportService {
  constructor(private readonly db: () => DataContext) {}

  mine(me: Identity): Promise<Record<string, unknown>[]> {
    return this.db().asUser(me, (tx) => new SupportRequestsRepository(tx).mine(me.userId));
  }

  async create(me: Identity, subject: string, message: string): Promise<{ id: string }> {
    return { id: await this.db().asUser(me, (tx) => new SupportRequestsRepository(tx).create(me.userId, subject, message)) };
  }

  /**
   * Links the files the user uploaded to their request. FIX B13: the table lets only admins update requests,
   * so the app's update matched no row and the attachments were never saved (admins never saw them). Only the
   * request's owner, only files in their own folder for that request, only this column.
   */
  async setAttachments(me: Identity, requestId: string, attachments: SupportAttachment[]): Promise<{ saved: true }> {
    const folder = `${me.userId}/${requestId}/`;
    if (attachments.some((a) => !a.path.startsWith(folder) || a.path.includes(".."))) throw badRequest("Attachments must be files uploaded for this request.");
    await this.db().onBehalfOf(me, async (tx) => {
      const repo = new SupportRequestsRepository(tx);
      if (!(await repo.isOwn(me.userId, requestId))) throw notFound("Support request not found.");
      await repo.setAttachments(requestId, attachments);
    });
    return { saved: true };
  }

  /** Deletes one's own request (the app's clean-up when an upload failed). Users may not delete requests: 0 removed, as before. */
  async remove(me: Identity, requestId: string): Promise<{ removed: number }> {
    return { removed: await this.db().asUser(me, (tx) => new SupportRequestsRepository(tx).remove(me.userId, requestId)) };
  }

  all(me: Identity): Promise<Record<string, unknown>[]> {
    return this.db().asUser(me, (tx) => new SupportRequestsRepository(tx).all());
  }

  async answer(me: Identity, requestId: string, status: string, adminReply: string | null): Promise<{ updated: number }> {
    return { updated: await this.db().asUser(me, (tx) => new SupportRequestsRepository(tx).answer(requestId, status, adminReply)) };
  }
}
