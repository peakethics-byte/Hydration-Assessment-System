// HGI trend over an athlete's assessments (single series, server-rendered SVG).
// Band boundaries (Document #1) are drawn as quiet reference lines; each point has a hover tooltip
// and a larger hit area. The history table on the same page is the table view of this chart.
export interface TrendPoint { label: string; hgi: number; band: string; kind: string }

const LINE = '#0ea5c4'; // validated for the dark surface (lightness band + contrast)
const BANDS = [
  { at: 90, label: 'Minimal' },
  { at: 75, label: 'Mild' },
  { at: 60, label: 'Moderate' },
  { at: 40, label: 'Significant' },
];

export default function TrendChart({ points }: { points: TrendPoint[] }) {
  if (points.length === 0) return <p className="muted">No scored assessments yet.</p>;
  const W = 720, H = 240, L = 44, R = 92, T = 16, B = 34;
  const x = (i: number) => (points.length === 1 ? L + (W - L - R) / 2 : L + (i * (W - L - R)) / (points.length - 1));
  const y = (v: number) => T + ((100 - v) * (H - T - B)) / 100;
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.hgi).toFixed(1)}`).join(' ');
  const last = points[points.length - 1];
  return (
    <figure className="trend" style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`HGI trend: ${points.map((p) => `${p.label} ${p.hgi.toFixed(1)}`).join(', ')}`}>
        {/* recessive grid: 0 and 100, plus the band boundaries */}
        {[0, 100].map((v) => <line key={v} x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="var(--line)" strokeWidth={1} />)}
        {BANDS.map((b) => (
          <g key={b.at}>
            <line x1={L} x2={W - R} y1={y(b.at)} y2={y(b.at)} stroke="var(--line-2)" strokeWidth={1} strokeDasharray="3 4" />
            <text x={W - R + 8} y={y(b.at) + 4} fontSize={11} fill="var(--faint)">{b.label} {b.at}</text>
          </g>
        ))}
        {[0, 100].map((v) => <text key={v} x={L - 8} y={y(v) + 4} fontSize={11} fill="var(--faint)" textAnchor="end">{v}</text>)}
        <path d={path} fill="none" stroke={LINE} strokeWidth={2} strokeLinejoin="round" />
        {points.map((p, i) => (
          <g key={i}>
            <circle cx={x(i)} cy={y(p.hgi)} r={14} fill="transparent">
              <title>{`${p.kind} · ${p.label}\nHGI ${p.hgi.toFixed(1)} · ${p.band}`}</title>
            </circle>
            <circle cx={x(i)} cy={y(p.hgi)} r={5} fill={LINE} stroke="var(--panel)" strokeWidth={2} pointerEvents="none" />
            <text x={x(i)} y={H - 12} fontSize={11} fill="var(--muted)" textAnchor="middle">{p.label}</text>
          </g>
        ))}
        {/* selective direct label: the latest value only */}
        <text x={x(points.length - 1)} y={y(last.hgi) - 12} fontSize={12} fontWeight={700} fill="var(--ink)" textAnchor="middle">{last.hgi.toFixed(1)}</text>
      </svg>
    </figure>
  );
}
