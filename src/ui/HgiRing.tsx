// HGI ring (0-100). Display only; the value comes from the stored result.
export default function HgiRing({ value, size = 140, id = 'hgiGrad' }: { value: number; size?: number; id?: string }) {
  const r = 52;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, value));
  return (
    <svg width={size} height={size} viewBox="0 0 140 140" role="img" aria-label={`HGI ${v} out of 100`}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#22d3ee" />
          <stop offset="100%" stopColor="#3b82f6" />
        </linearGradient>
      </defs>
      <circle cx="70" cy="70" r={r} fill="none" stroke="#1e2e40" strokeWidth="12" />
      <circle cx="70" cy="70" r={r} fill="none" stroke={`url(#${id})`} strokeWidth="12" strokeLinecap="round"
        strokeDasharray={`${(v / 100) * c} ${c}`} transform="rotate(-90 70 70)" />
      <path d="M70 44c-8 10.5-13.5 18-13.5 25a13.5 13.5 0 0 0 27 0c0-7-5.5-14.5-13.5-25Z" fill="#22d3ee" opacity="0.9" />
    </svg>
  );
}
