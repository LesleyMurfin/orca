// What a handover carries of the stopped messages owed to the agent, chosen in the session's
// serialized handover step so a phone and a desktop sending at once deliver each one once.

import type {
  AgentJournalMessageItem,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import {
  agentSessionSendCarriesStoppedHistory,
  agentSessionSendDeliversStoppedHistory,
  agentSessionStoppedHistoryOwed,
  selectStoppedHistory,
  type StoppedHistoryDelivery
} from '../../../shared/agent-session-stopped-history'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

type StoppedHistoryContext = {
  journal: Pick<
    AgentSessionJournal,
    'submissions' | 'itemBody' | 'liveTurnScope' | 'stoppedHistoryCarried'
  > & {
    context: Pick<AgentSessionJournal['context'], 'floor'>
  }
}

/** What a person's words-only send that opens a turn carries of the owed messages; null for a
 *  steer into a running turn, which may never record it, and for any other send. */
export function carriedStoppedHistory(
  ctx: StoppedHistoryContext,
  submission: AgentJournalSubmission,
  body: AgentJournalMessageItem
): StoppedHistoryDelivery | null {
  if (
    ctx.journal.liveTurnScope().kind !== 'thread' ||
    !agentSessionSendDeliversStoppedHistory(submission, body) ||
    !agentSessionSendCarriesStoppedHistory(body)
  ) {
    return null
  }
  return selectStoppedHistory(
    agentSessionStoppedHistoryOwed({
      submissions: ctx.journal.submissions(),
      carried: ctx.journal.stoppedHistoryCarried(),
      clearSequence: ctx.journal.context.floor()?.sequence ?? 0,
      body: (id) => ctx.journal.itemBody(agentJournalSubmissionKey(id))
    }),
    body
  )
}
