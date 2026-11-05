import { type ReactNode, useId, useLayoutEffect, useRef, useState } from 'react';
import { IconButton } from '../ui';

/**
 * The head of every top-level page: title (+ a chip such as the project slug), a one-line description, an optional
 * ⓘ toggle that reveals the longer explanation, and the page's tabs below.
 */
export function PageHeader({
  title, chip, description, more, clamp, tabs,
}: {
  title: ReactNode;
  chip?: ReactNode;
  description?: ReactNode;
  /** The longer explanation, hidden behind the ⓘ toggle next to the title. */
  more?: ReactNode;
  /** User-written descriptions: show at most 3 lines, with a More/Less toggle when the text is longer. */
  clamp?: boolean;
  tabs?: ReactNode;
}) {
  const [infoOpen, setInfoOpen] = useState(false);
  const infoId = useId();
  return (
    <header className="page-head">
      <div className="page-head__title">
        <h1>
          {title}
          {chip}
        </h1>
        {more && (
          <IconButton
            className="page-head__info"
            icon="info"
            label="About this page"
            aria-expanded={infoOpen}
            aria-controls={infoId}
            onClick={() => setInfoOpen(!infoOpen)}
          />
        )}
      </div>
      {description && (clamp ? <ClampedText>{description}</ClampedText> : <p className="page-head__desc">{description}</p>)}
      {more && (
        <div id={infoId} className="page-head__more" hidden={!infoOpen}>
          {more}
        </div>
      )}
      {tabs}
    </header>
  );
}

function ClampedText({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const id = useId();

  // Measure only while clamped: expanded text never overflows, and the Less button must stay.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || expanded) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [expanded, children]);

  return (
    <div className="page-head__clamp">
      <p ref={ref} id={id} className="page-head__desc" data-clamped={!expanded}>
        {children}
      </p>
      {overflows && (
        <button type="button" className="page-head__toggle" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Less' : 'More'}
        </button>
      )}
    </div>
  );
}
