// Rendu SVG d'une forme de dessin (stylo, ligne, flèche cintrée, rect, ellipse, losange, texte).
import type { ArrowHead, DrawShape } from "./referenceShared";
import { connectorPath, dashArray, penPath } from "./drawGeometry";

// Pointe posée à l'extrémité (tx,ty), `ang` = direction du tracé VERS la pointe. `c`/`w` = couleur/épaisseur.
function HeadMark({ type, tx, ty, ang, len, c, w }: {
  type: ArrowHead; tx: number; ty: number; ang: number; len: number; c: string; w: number;
}) {
  if (type === "none") return null;
  if (type === "dot") return <circle cx={tx} cy={ty} r={w * 1.6} fill={c} stroke="none" />;
  if (type === "bar") {
    const a = ang + Math.PI / 2;
    const hx = Math.cos(a) * w * 2.2, hy = Math.sin(a) * w * 2.2;
    return <line x1={tx - hx} y1={ty - hy} x2={tx + hx} y2={ty + hy} stroke={c} strokeWidth={w} strokeLinecap="round" />;
  }
  const a1 = ang + Math.PI * 0.82, a2 = ang - Math.PI * 0.82;
  const p1x = tx + Math.cos(a1) * len, p1y = ty + Math.sin(a1) * len;
  const p2x = tx + Math.cos(a2) * len, p2y = ty + Math.sin(a2) * len;
  if (type === "triangle") {
    return <polygon points={`${tx},${ty} ${p1x},${p1y} ${p2x},${p2y}`} fill={c} stroke={c} strokeWidth={w} strokeLinejoin="round" />;
  }
  // "arrow" = chevron ouvert
  return (
    <g fill="none" stroke={c} strokeWidth={w} strokeLinecap="round" strokeLinejoin="round">
      <line x1={tx} y1={ty} x2={p1x} y2={p1y} />
      <line x1={tx} y1={ty} x2={p2x} y2={p2y} />
    </g>
  );
}

export function ShapeView({ s }: { s: DrawShape }) {
  // `op` = opacité de la FORME entière (trait + remplissage + pointes) — surligneur & réglage libre.
  const op = s.op != null && s.op < 1 ? s.op : undefined;
  const common = { stroke: s.c, strokeWidth: s.w, fill: "none", strokeLinecap: "round" as const, strokeLinejoin: "round" as const, strokeDasharray: dashArray(s.dash, s.w), opacity: op };
  if (s.t === "pen") return <path d={penPath(s.p)} {...common} />;
  if (s.t === "line" || s.t === "arrow") {
    const [x1, y1, x2, y2] = s.p;
    const { d, startAng, endAng } = connectorPath(s);
    // Pointe proportionnelle au TRAIT, pas à la longueur : une flèche liée à deux médias grandit en
    // longueur quand ils s'écartent, sa pointe reste de la même taille (bornée à 8× l'épaisseur).
    const len = Math.min(s.w * 8, Math.max(s.w * 3.5, Math.hypot(x2 - x1, y2 - y1) * 0.18));
    // flèche : pointe par défaut à l'arrivée si aucune n'est définie ; ligne : aucune par défaut.
    const h2 = s.h2 ?? (s.t === "arrow" ? "arrow" : "none");
    const h1 = s.h1 ?? "none";
    return (
      <g opacity={op}>
        <path d={d} {...common} opacity={undefined} />
        <HeadMark type={h1} tx={x1} ty={y1} ang={startAng} len={len} c={s.c} w={s.w} />
        <HeadMark type={h2} tx={x2} ty={y2} ang={endAng} len={len} c={s.c} w={s.w} />
      </g>
    );
  }
  if (s.t === "rect") {
    const x = Math.min(s.p[0], s.p[2]), y = Math.min(s.p[1], s.p[3]);
    const w0 = Math.abs(s.p[2] - s.p[0]), h0 = Math.abs(s.p[3] - s.p[1]);
    // coins arrondis proportionnels (unités monde → scale avec le zoom, façon encre).
    const rr = s.r ? Math.min(w0, h0) * 0.12 : undefined;
    return <rect x={x} y={y} width={w0} height={h0} rx={rr} ry={rr} {...common} fill={s.fill || "none"} />;
  }
  if (s.t === "ellipse") {
    const cx = (s.p[0] + s.p[2]) / 2, cy = (s.p[1] + s.p[3]) / 2;
    return <ellipse cx={cx} cy={cy} rx={Math.abs(s.p[2] - s.p[0]) / 2} ry={Math.abs(s.p[3] - s.p[1]) / 2} {...common} fill={s.fill || "none"} />;
  }
  if (s.t === "diamond") {
    const x0 = Math.min(s.p[0], s.p[2]), y0 = Math.min(s.p[1], s.p[3]);
    const x1 = Math.max(s.p[0], s.p[2]), y1 = Math.max(s.p[1], s.p[3]);
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    return <polygon points={`${cx},${y0} ${x1},${cy} ${cx},${y1} ${x0},${cy}`} {...common} fill={s.fill || "none"} />;
  }
  // text
  return (
    <text x={s.p[0]} y={s.p[1]} fill={s.c} fontSize={s.w} opacity={op} dominantBaseline="hanging" style={{ fontFamily: "Inter, system-ui, sans-serif", whiteSpace: "pre" }}>
      {s.text}
    </text>
  );
}
