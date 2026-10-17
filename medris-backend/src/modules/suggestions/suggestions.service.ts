import type { DataContext, Identity } from "../../database/context.js";
import { AccessRepository } from "../../database/repositories/access.repository.js";
import { SuggestionsRepository } from "../../database/repositories/suggestions.repository.js";
import { badRequest, forbidden, notFound } from "../../shared/errors/app-error.js";
import type { Suggestion } from "./suggestions.schemas.js";
import { isSqlBlank } from "../../lib/sql-text.js";

/** The suggestion box: anyone can write to a shop or to Levromart; the shop / admins read it. */
export class SuggestionsService {
  constructor(private readonly db: () => DataContext) {}

  /** Replaces: public.submit_suggestion(text, uuid, text, boolean) - returns the new id. */
  async submit(
    me: Identity | null,
    input: { targetType: string; targetVendorId?: string | null; message?: string | null; isAnonymous?: boolean | null },
  ): Promise<{ id: string }> {
    if (isSqlBlank(input.message)) throw badRequest("Message is required.");
    if (input.targetType === "vendor" && !input.targetVendorId) throw badRequest("A vendor must be specified.");
    const create = (repo: SuggestionsRepository) =>
      repo.create(me?.userId ?? null, input.targetType, input.targetVendorId ?? null, input.message!, input.isAnonymous ?? false);
    // Signed in: on the sender's behalf (triggers see them). Signed out: anonymous, as before.
    const id = me
      ? await this.db().onBehalfOf(me, (tx) => create(new SuggestionsRepository(tx)))
      : await this.db().asService((tx) => create(new SuggestionsRepository(tx)));
    return { id };
  }

  /** Replaces: public.get_vendor_suggestions() - suggestions sent to the caller's shop. */
  vendorSuggestions(me: Identity | null): Promise<Suggestion[]> {
    return this.db().asService(async (tx) => {
      const vendorId = await new AccessRepository(tx).liveVendorIdOf(me?.userId);
      if (!vendorId) throw notFound("No vendor profile found.");
      return new SuggestionsRepository(tx).list({ vendorId });
    });
  }

  /** Replaces: public.get_platform_suggestions() - admins only. */
  platformSuggestions(me: Identity | null): Promise<Suggestion[]> {
    return this.db().asService(async (tx) => {
      if (!(await new AccessRepository(tx).isAdmin(me?.userId))) throw forbidden("Admins only.");
      return new SuggestionsRepository(tx).list("platform");
    });
  }

  /** Replaces: public.mark_suggestion_read(uuid) - the receiving shop, or an admin for platform suggestions. */
  async markRead(me: Identity | null, suggestionId: string): Promise<{ done: true }> {
    await this.db().asService(async (tx) => {
      const repo = new SuggestionsRepository(tx);
      const access = new AccessRepository(tx);
      const row = await repo.find(suggestionId);
      if (!row) throw notFound("Not found.");
      if (row.target_type === "platform") {
        if (!(await access.isAdmin(me?.userId))) throw forbidden("Not allowed.");
      } else {
        const vendorId = await access.liveVendorIdOf(me?.userId);
        if (!vendorId || vendorId !== row.target_vendor_id) throw forbidden("Not allowed.");
      }
      await repo.markRead(suggestionId);
    });
    return { done: true };
  }
}
