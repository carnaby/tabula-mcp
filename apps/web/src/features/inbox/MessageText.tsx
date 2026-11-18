import { useState } from 'react';
import { Button, Markdown } from '../../ui';

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
        <pre className="message-text__source">{text}</pre>
      )}
      <Button className="message-text__toggle" variant="ghost" size="sm" onClick={() => setFormatted(!formatted)}>
        {formatted ? 'Show exact text' : 'Show formatted'}
      </Button>
    </div>
  );
}
