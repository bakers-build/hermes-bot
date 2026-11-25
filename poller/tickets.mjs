// Pure core of the poller's ticket discovery: a ticket's conversation (its side reads it from
// the links, poller/sides), inherited by sub-tickets that have none. No I/O.

/**
 * Gives each sub-ticket without a conversation that of its nearest ancestor with one, and
 * marks it `inherited`: its posts name it, and the channel is not its own to rename or archive.
 *
 * @param {Array<{id: string, parent: string | null, conversation: object | null}>} tickets changed in place
 */
export function conversations(tickets) {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const own = new Map(tickets.map((t) => [t.id, t.conversation]));
  for (const ticket of tickets) {
    if (own.get(ticket.id)) continue;
    let ancestor = byId.get(ticket.parent);
    const seen = new Set();
    while (ancestor && !own.get(ancestor.id) && !seen.has(ancestor.id)) {
      seen.add(ancestor.id);
      ancestor = byId.get(ancestor.parent);
    }
    if (ancestor && own.get(ancestor.id)) Object.assign(ticket, { conversation: own.get(ancestor.id), inherited: true });
  }
}
