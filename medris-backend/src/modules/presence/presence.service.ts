import type { DataContext, Identity } from "../../database/context.js";
import { PresenceRepository } from "../../database/repositories/presence.repository.js";
import { unauthenticated } from "../../shared/errors/app-error.js";

/** "Online now" and "last seen". */
export class PresenceService {
  constructor(private readonly db: () => DataContext) {}

  /** Replaces: public.touch_presence() - the app is open (sent periodically while it is). */
  async touch(me: Identity | null): Promise<{ done: true }> {
    if (!me) throw unauthenticated();
    await this.db().onBehalfOf(me, (tx) => new PresenceRepository(tx).touchApp(me.userId));
    return { done: true };
  }

  /** Replaces: public.clear_presence() - the app was closed. */
  async clear(me: Identity | null): Promise<{ done: true }> {
    if (!me) throw unauthenticated();
    await this.db().onBehalfOf(me, (tx) => new PresenceRepository(tx).clearApp(me.userId));
    return { done: true };
  }

  /** Replaces: public.touch_last_seen() - signed out, nothing happens (as before). */
  async touchLastSeen(me: Identity | null): Promise<{ done: true }> {
    if (me) await this.db().onBehalfOf(me, (tx) => new PresenceRepository(tx).touchLastSeen(me.userId));
    return { done: true };
  }

  /**
   * Replaces: public.get_conversation_presence(uuid) - when the other person in the caller's
   * conversation was last active (null when the caller does not take part).
   */
  async conversationPresence(me: Identity | null, conversationId: string): Promise<{ last_seen_at: string | null }> {
    if (!me) return { last_seen_at: null };
    const other = await this.db().asService((tx) => new PresenceRepository(tx).otherSide(me.userId, conversationId));
    if (!other) return { last_seen_at: null };
    const signIn = await this.db().asAuthReader((tx) => new PresenceRepository(tx).lastSignIn(other));
    return { last_seen_at: await this.db().asService((tx) => new PresenceRepository(tx).lastSeen(other, signIn)) };
  }
}
