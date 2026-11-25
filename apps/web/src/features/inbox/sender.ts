/**
 * The sender as the owner reads it. A project's name is declared by the sending agent and not verified. Without a sender
 * project, "author" is you through an app and "external" an agent outside any project; both carry the app connection in
 * `via`, which its token verified, and "external" also the agent's own description in `sender`, which nothing verifies.
 */
type Sender = { from: string; via?: string; sender?: string };

export const isExternal = (m: { from: string }): boolean => m.from === 'external';

/** Whether a project sent it, so the message can wait on the sender. */
export const hasSenderProject = (m: { from: string }): boolean => m.from !== 'author' && m.from !== 'external';

export const senderText = (m: Sender): string =>
  m.from === 'author' ? `You (via ${m.via})` : isExternal(m) ? `${m.sender} (via ${m.via})` : m.from;

/** The whole sender is declared only for a project; an external message shows its own badge instead. */
export const isDeclared = (m: { from: string }): boolean => hasSenderProject(m);

export const senderTitle = (m: Sender): string =>
  m.from === 'author'
    ? 'Sent by you through an app connection'
    : isExternal(m)
      ? `Sent by an agent outside any project through the app connection ${m.via}; the description is declared by the agent, not verified`
      : 'Declared by the sender, not verified';
