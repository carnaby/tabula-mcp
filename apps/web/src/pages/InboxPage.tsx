import { InboxList } from '../features/inbox/InboxList';
import { MessageTokens } from '../features/inbox/MessageTokens';
import { PageHeader } from '../features/PageHeader';
import type { Project } from '../types';

export function InboxPage({ projects }: { projects: Project[] | undefined }) {
  return (
    <main className="content content--wide">
      <PageHeader
        title="Inbox"
        description="Requests and reports between projects."
        more="Agents send messages here. What was sent never changes; replies and status changes are added to the message's history. The sender's name is what the sender declared, Tabula does not verify it."
      />
      <div className="t-stack">
        <InboxList projects={projects} />
        <MessageTokens projects={projects} />
      </div>
    </main>
  );
}
