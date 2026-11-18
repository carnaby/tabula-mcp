import { useState } from 'react';
import { Button, Markdown } from '../../ui';

/**
 * Text written by someone else: rendered, or exactly as stored. Rendering can still tuck text away (a link's title or
 * target), and the owner decides from this page, so the stored text is always one click away.
 */
export function MessageText({ text }: { text: string }) {
  const [source, setSource] = useState(false);
  return (
    <div className="message-text">
      {source ? <pre className="message-text__source">{text}</pre> : <Markdown untrusted source={text} />}
      <Button className="message-text__toggle" variant="ghost" size="sm" onClick={() => setSource(!source)}>
        {source ? 'View rendered' : 'View source'}
      </Button>
    </div>
  );
}
