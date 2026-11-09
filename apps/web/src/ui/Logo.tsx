/** The Tabula mark: a wax writing tablet with a stylus. Same drawing as public/favicon.svg. */
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="tabula-wax" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fcd34d" />
          <stop offset="1" stopColor="#d97706" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="15" fill="#1c1917" />
      <rect x="12" y="11" width="34" height="42" rx="6" fill="#78350f" />
      <rect x="15.5" y="14.5" width="27" height="35" rx="3.5" fill="url(#tabula-wax)" />
      <path d="M21 24h15M21 31h11M21 38h13" stroke="#78350f" strokeWidth="3" strokeLinecap="round" />
      <path d="M53 12 38.5 44.5" stroke="#f5f5f4" strokeWidth="4.5" strokeLinecap="round" />
      <path d="M40.6 45.4 36.3 50.6 36.4 43.6z" fill="#f5f5f4" stroke="#f5f5f4" strokeWidth="1" strokeLinejoin="round" />
    </svg>
  );
}

export function Logo() {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
      <LogoMark />
      <span style={{ fontWeight: 700, fontSize: 17, letterSpacing: '-0.02em' }}>Tabula</span>
    </span>
  );
}
