import { findRef } from '@tabula/shared/refs';
import { type ReactNode, useState } from 'react';
import { href } from '../../router';
import { Button, Markdown } from '../../ui';

/**
 * The exact text with each reference (tabula:xxxxxxxx) as a link to the Search page, like in Markdown. The link shows
 * the text as written (its letter case too), so the element's text stays exactly the stored text.
 */
function withRefLinks(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let offset = 0;
  // After a reference comes no word character, so a match at the start of the rest is a match in the whole text too.
  for (let m = findRef(rest); m; m = findRef(rest)) {
    if (m.index > 0) out.push(rest.slice(0, m.index));
    out.push(<a key={offset + m.index} className="ref-link" href={href.search(m.ref)}>{rest.slice(m.index, m.index + m.length)}</a>);
    offset += m.index + m.length;
    rest = rest.slice(m.index + m.length);
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Text written by someone else. It opens exactly as stored, because the owner decides from this page and agents receive
 * this text. Formatting is an option: Markdown can leave parts of a text out.
 */
export function MessageText({ text }: { text: string }) {
  const [formatted, setFormatted] = useState(false);
  return (
    <div className="message-text">
      {formatted ? (
        <>
          <p className="message-text__note t-subtle">Formatting can leave parts out. The exact text is what agents receive.</p>
          <Markdown untrusted source={text} />
        </>
      ) : (
        <pre className="message-text__source">{withRefLinks(text)}</pre>
      )}
      <Button className="message-text__toggle" variant="ghost" size="sm" onClick={() => setFormatted(!formatted)}>
        {formatted ? 'Show exact text' : 'Show formatted'}
      </Button>
    </div>
  );
}
