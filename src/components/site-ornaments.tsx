/**
 * Decorations for the "ornate" wedding-site theme: marigold torans, roses and floral dividers.
 * Pure inline SVG (no images to load), decorative only (aria-hidden), and drawn in fixed
 * festive colours so they look the same whatever accent the family picks.
 */

const MARIGOLD = { outer: "#f59e0b", mid: "#fbbf24", inner: "#f97316", centre: "#b45309" };
const ROSE = { petal: "#c2185b", deep: "#9b111e", light: "#e05a8a" };
const LEAF = "#3f7d3a";

/** One marigold head: rings of overlapping petals. */
function Marigold({ x, y, r = 9 }: { x: number; y: number; r?: number }) {
  const ring = (radius: number, count: number, size: number, fill: string, offset = 0) =>
    Array.from({ length: count }, (_, i) => {
      const a = ((i / count) * 360 + offset) * (Math.PI / 180);
      return <circle key={`${radius}-${i}`} cx={x + Math.cos(a) * radius} cy={y + Math.sin(a) * radius} r={size} fill={fill} />;
    });
  return (
    <g>
      {ring(r * 0.72, 12, r * 0.42, MARIGOLD.outer)}
      {ring(r * 0.45, 9, r * 0.36, MARIGOLD.mid, 20)}
      {ring(r * 0.2, 6, r * 0.3, MARIGOLD.inner, 10)}
      <circle cx={x} cy={y} r={r * 0.18} fill={MARIGOLD.centre} />
    </g>
  );
}

/** A small rose: spiral of petals in magenta/ruby. */
function Rose({ x, y, r = 10 }: { x: number; y: number; r?: number }) {
  return (
    <g>
      <circle cx={x} cy={y} r={r} fill={ROSE.petal} />
      <path d={`M${x - r * 0.75} ${y} a${r * 0.75} ${r * 0.75} 0 0 1 ${r * 1.5} 0`} fill="none" stroke={ROSE.light} strokeWidth={r * 0.18} />
      <circle cx={x} cy={y + r * 0.08} r={r * 0.62} fill={ROSE.deep} />
      <path d={`M${x - r * 0.4} ${y + r * 0.1} q${r * 0.4} ${-r * 0.55} ${r * 0.8} 0 q${-r * 0.4} ${r * 0.45} ${-r * 0.55} ${-r * 0.05}`} fill="none" stroke={ROSE.light} strokeWidth={r * 0.14} strokeLinecap="round" />
      <circle cx={x + r * 0.05} cy={y + r * 0.02} r={r * 0.16} fill={ROSE.light} />
    </g>
  );
}

function Leaf({ x, y, angle = 0, s = 1 }: { x: number; y: number; angle?: number; s?: number }) {
  return (
    <path
      d="M0 0 C 6 -6, 16 -6, 22 0 C 16 6, 6 6, 0 0 Z"
      transform={`translate(${x} ${y}) rotate(${angle}) scale(${s})`}
      fill={LEAF}
      opacity="0.9"
    />
  );
}

/**
 * Toran: a swag of marigolds along the top of the page with hanging marigold strings and
 * mango leaves, like the garlands over a wedding doorway. Scales to any width.
 */
export function Toran({ className = "" }: { className?: string }) {
  const W = 800;
  const swags = 4;
  const sw = W / swags;
  const flowers: { x: number; y: number }[] = [];
  for (let s = 0; s < swags; s++) {
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      flowers.push({ x: s * sw + t * sw, y: 10 + Math.sin(Math.PI * t) * 26 });
    }
  }
  const strings = Array.from({ length: swags + 1 }, (_, i) => i * sw);
  return (
    <svg aria-hidden viewBox={`0 0 ${W} 110`} preserveAspectRatio="xMidYMin slice" className={`block h-20 w-full sm:h-28 ${className}`}>
      <rect x="0" y="0" width={W} height="6" fill={ROSE.deep} />
      {strings.map((x) => (
        <g key={`s${x}`}>
          <line x1={x} y1="6" x2={x} y2="86" stroke={MARIGOLD.centre} strokeWidth="1" opacity="0.5" />
          {[20, 36, 52, 68].map((y) => (
            <Marigold key={y} x={x} y={y} r={7} />
          ))}
          <Rose x={x} y={92} r={8} />
        </g>
      ))}
      {Array.from({ length: swags }, (_, s) => (
        <g key={`l${s}`}>
          <Leaf x={s * sw + sw * 0.32} y={16} angle={110} s={0.9} />
          <Leaf x={s * sw + sw * 0.68} y={16} angle={70} s={0.9} />
          <Leaf x={s * sw + sw * 0.5} y={40} angle={90} s={1} />
        </g>
      ))}
      {flowers.map((f, i) => (
        <Marigold key={i} x={f.x} y={f.y} r={i % 2 ? 8 : 9.5} />
      ))}
    </svg>
  );
}

/** Divider under section titles: roses and marigolds on a vine. */
export function FloralDivider({ className = "" }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 240 28" className={`h-6 w-48 ${className}`}>
      <path d="M8 14 C 50 2, 80 26, 120 14 S 190 2, 232 14" fill="none" stroke={MARIGOLD.centre} strokeWidth="1.2" opacity="0.6" />
      <Leaf x={70} y={12} angle={-25} s={0.7} />
      <Leaf x={152} y={16} angle={205} s={0.7} />
      <Marigold x={40} y={11} r={6} />
      <Marigold x={200} y={11} r={6} />
      <Rose x={96} y={16} r={6} />
      <Rose x={144} y={13} r={6} />
      <Marigold x={120} y={14} r={8} />
    </svg>
  );
}

/** A corner posy of roses and marigolds; mirror with `flip` for the other side. */
export function RoseCorner({ flip = false, className = "" }: { flip?: boolean; className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 90 90" className={className} style={flip ? { transform: "scaleX(-1)" } : undefined}>
      <Leaf x={20} y={58} angle={-60} s={1.3} />
      <Leaf x={40} y={30} angle={-10} s={1.1} />
      <Leaf x={52} y={66} angle={-110} s={1} />
      <Rose x={26} y={40} r={14} />
      <Marigold x={50} y={52} r={11} />
      <Rose x={16} y={68} r={9} />
      <Marigold x={44} y={20} r={7} />
    </svg>
  );
}
