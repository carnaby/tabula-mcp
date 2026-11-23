/**
 * The sender as the owner reads it. A project's name is declared by the sending agent and not verified; a message the
 * owner sent through an app comes as from "author" with the app connection in `via`, which its token verified.
 */
export const senderText = (m: { from: string; via?: string }): string => (m.via !== undefined ? `You (via ${m.via})` : m.from);

export const isDeclared = (m: { via?: string }): boolean => m.via === undefined;

export const senderTitle = (m: { via?: string }): string =>
  isDeclared(m) ? 'Declared by the sender, not verified' : 'Sent by you through an app connection';
