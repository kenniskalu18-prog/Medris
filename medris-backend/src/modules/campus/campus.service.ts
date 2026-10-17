import type { DataContext, Identity } from "../../database/context.js";
import { AccessRepository } from "../../database/repositories/access.repository.js";
import { CampusRepository } from "../../database/repositories/shops.repository.js";
import { badRequest, forbidden, unauthenticated } from "../../shared/errors/app-error.js";

/** Schools for campus listings: the list, what users add, and the admin's review. */
export class CampusService {
  constructor(private readonly db: () => DataContext) {}

  /** Replaces: public.campus_school_names() - pending and approved schools, newest first. */
  schoolNames(): Promise<{ name: string; status: string }[]> {
    return this.db().asService((tx) => new CampusRepository(tx).names());
  }

  /** Replaces: public.submit_campus_school(text) - a school not in the list; the same school again counts one more request. */
  async submit(me: Identity | null, name: string | null): Promise<{ status: string; merged_into: string | null }[]> {
    if (!me) throw unauthenticated("not signed in");
    return this.db().onBehalfOf(me, async (tx) => {
      const campus = new CampusRepository(tx);
      const norm = await campus.normalise(name);
      if ([...norm].length < 3) throw badRequest("name too short");
      return campus.submit(norm, name ?? "", me.userId);
    });
  }

  /** Replaces: public.admin_campus_submissions() - schools waiting for review. */
  async pending(me: Identity | null): Promise<Record<string, unknown>[]> {
    return this.db().asService(async (tx) => {
      if (!(await new AccessRepository(tx).isAdmin(me?.userId))) throw forbidden("admin only");
      return new CampusRepository(tx).pending();
    });
  }

  /**
   * Replaces: public.admin_review_campus_school(text, text, text) - approve the school, merge it into
   * an existing one (everyone who typed it moves there), or reject it (they get "none").
   */
  async review(me: Identity | null, norm: string, action: string, target: string | null): Promise<{ done: true }> {
    const run = async (tx: Parameters<Parameters<DataContext["asService"]>[0]>[0]) => {
      if (!(await new AccessRepository(tx).isAdmin(me?.userId))) throw forbidden("admin only");
      const campus = new CampusRepository(tx);
      if (action === "approve") await campus.setStatus(norm, "approved");
      else if (action === "merge") {
        if (target == null || target === "") throw badRequest("target required");
        await campus.reassign(norm, target);
        await campus.setStatus(norm, "merged", target);
      } else if (action === "reject") {
        await campus.reassign(norm, "none");
        await campus.setStatus(norm, "rejected");
      } else throw badRequest("bad action");
    };
    await (me ? this.db().onBehalfOf(me, run) : this.db().asService(run));
    return { done: true };
  }
}
