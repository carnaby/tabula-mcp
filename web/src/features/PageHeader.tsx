import { type ReactNode, useId, useLayoutEffect, useRef, useState } from 'react';
import { IconButton, TextButton } from '../ui';

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
  const info = useInfo();
  return (
    <header className="page-head">
      <div className="page-head__title">
        <h1>
          {title}
          {chip}
        </h1>
        {more && <InfoButton {...info} label="About this page" />}
      </div>
      {description && (clamp ? <ClampedText>{description}</ClampedText> : <p className="page-head__desc">{description}</p>)}
      {more && <InfoMore {...info}>{more}</InfoMore>}
      {tabs}
    </header>
  );
}

/** A short line with an ⓘ toggle at its end that reveals the longer explanation below (e.g. inside a tab). */
export function InfoLine({ children, more, label = 'More about this' }: { children: ReactNode; more: ReactNode; label?: string }) {
  const info = useInfo();
  return (
    <div className="t-stack" style={{ gap: 6 }}>
      <div className="info-line">
        <p className="t-muted">{children}</p>
        <InfoButton {...info} label={label} />
      </div>
      <InfoMore {...info}>{more}</InfoMore>
    </div>
  );
}

type Info = { open: boolean; toggle: () => void; id: string };

function useInfo(): Info {
  const [open, setOpen] = useState(false);
  const id = useId();
  return { open, toggle: () => setOpen((o) => !o), id };
}

function InfoButton({ open, toggle, id, label }: Info & { label: string }) {
  return <IconButton className="info-btn" icon="info" label={label} aria-expanded={open} aria-controls={id} onClick={toggle} />;
}

function InfoMore({ open, id, children }: Info & { children: ReactNode }) {
  return (
    <div id={id} className="info-more" hidden={!open}>
      {children}
    </div>
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
        <TextButton aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Less' : 'More'}
        </TextButton>
      )}
    </div>
  );
}
