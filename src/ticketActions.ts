/** What the Dashboard's Backlog tab does to a Ticket. Browser and server share this file, so it imports nothing from Node. */

/** The bd actor behind ysz's claims and writes, so they are told apart from the human's. */
export const ORCHESTRATOR = 'orchestrator';

export const TICKET_ACTIONS = ['mark-ready', 'unmark-ready', 'skip', 'allow', 'unassign'] as const;
export type TicketAction = (typeof TICKET_ACTIONS)[number];

/** A Ticket's fields as `bd list --brief` and `bd show --json` both name them. */
export interface TicketFacts {
  id: string;
  issue_type: string;
  status: string;
  assignee?: string | null;
  labels?: string[] | null;
}

/**
 * Why `action` is not allowed on the Ticket, or null when it is. Nothing is allowed on an epic, a closed Ticket or one
 * ysz holds (in-review included). Open blockers and a human assignee do not stop Mark Ready: the Ticket waits.
 */
export function refusal(t: TicketFacts, action: TicketAction): string | null {
  const labels = t.labels ?? [];
  if (t.issue_type === 'epic') return `${t.id} is an epic`;
  if (t.status === 'closed') return `${t.id} is closed`;
  if (t.status === 'in_progress' && t.assignee === ORCHESTRATOR) return `${t.id} is held by ysz`;
  if (action === 'mark-ready' && labels.includes('ready-for-agent')) return `${t.id} is already Ready`;
  if (action === 'unmark-ready' && !labels.includes('ready-for-agent')) return `${t.id} is not Ready`;
  if (action === 'skip' && labels.includes('orchestrator:skip')) return `${t.id} is already skipped`;
  if (action === 'allow' && !labels.includes('orchestrator:skip')) return `${t.id} is not skipped`;
  if (action === 'unassign' && !t.assignee) return `${t.id} has no assignee`;
  // Unassign reopens the Ticket, so a deferred or blocked one keeps its status and its assignee.
  if (action === 'unassign' && t.status !== 'open' && t.status !== 'in_progress') return `${t.id} is ${t.status}`;
  return null;
}

/** The actions the Ticket allows now: Mark Ready or Unmark Ready, Skip ysz or Allow ysz, and Unassign while it has an assignee. */
export const allowedActions = (t: TicketFacts): TicketAction[] => TICKET_ACTIONS.filter((a) => !refusal(t, a));
