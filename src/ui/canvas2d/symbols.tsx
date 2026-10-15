/**
 * Plan symbols — the marks that make a rectangle readable.
 *
 * A floor plan is not a picture of furniture; it is a *notation*. A plain
 * filled rectangle tells you a sofa is 2.1 m long and nothing else. The
 * conventions below put one more piece of information into each mark at no
 * extra cost: a back band on a sofa says which way it faces, an ellipse in a
 * bathtub says which end the water goes in, four circles on a cooktop say
 * there are four burners.
 *
 * Everything keys off data that is already in the catalogue (`shape`,
 * `category`, the real footprint), so a symbol can never disagree with the
 * model about what an object is or how big it is. There is no symbol library
 * and no invented geometry: where a catalogue item has no dedicated mark, it
 * draws as a plain box, which is what a drawing does too.
 */
import { doorLeaf } from '../../model/geometry.ts';
import type { CatalogItem } from '../../model/catalog.ts';
import type { Opening, Vec2, Wall } from '../../model/types.ts';

/* ─────────────────────────────────────────────────────────── doors & windows ─── */

/** The pixel box a mark is drawn into, and the ink it is drawn with. */
export interface MarkProps {
  w: number;
  h: number;
  stroke: string;
}

interface SymbolProps {
  wall: Wall;
  opening: Opening;
  /** Plan → screen. */
  toScreen(p: Vec2): [number, number];
  scale: number;
  /**
   * Half the drawn wall thickness, in METRES. `toScreen` applies the zoom, so
   * passing pixels here is a units bug waiting to happen — it is metres
   * because every point in this file goes through `toScreen`.
   */
  halfM: number;
  ink: string;
  glass: string;
}

/**
 * A door: the leaf line, the quarter-circle sweep, and the jamb tick.
 *
 * Below about 26 px of leaf the arc collapses into noise, so the sweep is
 * dropped and only the gap in the wall is drawn — which is what a drawing at
 * 1:200 does too.
 */
export function DoorSymbol({ wall, opening, toScreen, scale, ink }: SymbolProps) {
  const leaf = doorLeaf(wall, opening);
  const [hx, hy] = toScreen(leaf.hinge);
  const [fx, fy] = toScreen(leaf.far);
  const [ox, oy] = toScreen(leaf.openEnd);
  const readable = opening.width * scale > 26;

  // A real arc segment, not a quadratic. A quadratic can only approximate a
  // quarter-circle — even with the control point at the intersection of the two
  // tangents it misses by about 6 % of the radius, which at a door's scale is
  // visibly flat.
  const sweep = `M ${fx.toFixed(1)} ${fy.toFixed(1)} A ${leaf.radius * scale} ${(leaf.radius * scale).toFixed(1)} 0 0 ${leaf.sweep} ${ox.toFixed(1)} ${oy.toFixed(1)}`;

  return (
    <g style={{ pointerEvents: 'none' }}>
      {readable ? (
        <>
          {/* Where the leaf sits when open. */}
          <line x1={hx} y1={hy} x2={ox} y2={oy} stroke={ink} strokeWidth={1.1} strokeLinecap="round" />
          {/* Where it sweeps. */}
          <path d={sweep} fill="none" stroke={ink} strokeWidth={0.7} opacity={0.75} />
        </>
      ) : (
        /* Too small for a sweep: a dot on the hinge so the opening still reads. */
        <circle cx={hx} cy={hy} r={1.2} fill={ink} />
      )}
    </g>
  );
}

/**
 * A window: two frame lines and a glazing line across the wall.
 *
 * The old symbol was a blue rectangle laid over the wall, which read as a
 * sticker rather than as a hole in a wall. A window is drawn the way it is
 * built — a gap with the frame either side of it.
 */
export function WindowSymbol({ wall, opening, toScreen, halfM, ink, glass }: SymbolProps) {
  const half = opening.width / 2;
  const along = opening.offset;
  const at = (s: number, side: number): [number, number] => {
    const len = Math.hypot(wall.b.x - wall.a.x, wall.b.y - wall.a.y) || 1;
    const ux = (wall.b.x - wall.a.x) / len;
    const uy = (wall.b.y - wall.a.y) / len;
    return toScreen({
      x: wall.a.x + ux * s - uy * side,
      y: wall.a.y + uy * s + ux * side,
    });
  };
  // Set just inside the wall face, so the frame reads as a lining and the gap
  // in the poché around it stays the thickness of the wall.
  const frame = Math.max(halfM - 0.02, 0.012);
  const [ax, ay] = at(along - half, -frame);
  const [bx, by] = at(along + half, -frame);
  const [cx, cy] = at(along + half, frame);
  const [dx, dy] = at(along - half, frame);
  const [gx1, gy1] = at(along - half, 0);
  const [gx2, gy2] = at(along + half, 0);

  return (
    <g style={{ pointerEvents: 'none' }}>
      <polygon
        points={`${ax},${ay} ${bx},${by} ${cx},${cy} ${dx},${dy}`}
        fill="none"
        stroke={ink}
        strokeWidth={0.8}
        opacity={0.8}
      />
      <line x1={gx1} y1={gy1} x2={gx2} y2={gy2} stroke={glass} strokeWidth={1.4} />
    </g>
  );
}

/* ─────────────────────────────────────────────────────────────── furniture ─── */

export interface FurnitureGlyphProps {
  /** `undefined` when the item's catalogue id is not in the catalogue. */
  item: CatalogItem | undefined;
  /** Pixel box the glyph is drawn into — the footprint at the current zoom. */
  w: number;
  h: number;
  fill: string;
  stroke: string;
  /** Detail is dropped on small footprints so the mark stays legible. */
  detail: boolean;
}

/**
 * The plan symbol for one catalogue item.
 *
 * `shape` is the first key, because it is already on the data: a cylinder is
 * drawn as a cylinder. Only then do the hand-written marks apply, and only for
 * real catalogue ids — an id that does not exist falls through to the box
 * rather than rendering an empty group.
 */
export function FurnitureGlyph({ item, w, h, fill, stroke, detail }: FurnitureGlyphProps) {
  const box = (
    <rect x={0} y={0} width={w} height={h} fill={fill} stroke={stroke} strokeWidth={0.75} />
  );

  if (!item) return box;

  if (item.shape === 'cylinder' || item.shape === 'round') {
    return (
      <g>
        <ellipse cx={w / 2} cy={h / 2} rx={w / 2} ry={h / 2} fill={fill} stroke={stroke} strokeWidth={0.75} />
        {detail && w > 16 && h > 16 && (
          <ellipse cx={w / 2} cy={h / 2} rx={w / 4} ry={h / 4} fill="none" stroke={stroke} strokeWidth={0.5} opacity={0.6} />
        )}
      </g>
    );
  }

  if (item.shape === 'lshape') {
    // Main run across the top, return down one end — the shape of the thing.
    const arm = Math.max(6, Math.min(w * 0.34, h));
    return (
      <g>
        <path
          d={`M0 0 H${w} V${arm} H${arm} V${h} H0 Z`}
          fill={fill}
          stroke={stroke}
          strokeWidth={0.75}
        />
        {detail && (
          <path
            d={`M${arm} ${arm} H${w} V${h} H${arm} Z`}
            fill="none"
            stroke={stroke}
            strokeWidth={0.5}
            opacity={0.55}
          />
        )}
      </g>
    );
  }

  if (item.shape === 'panel') {
    // A shallow run against a wall: hatched rather than solid, so it reads as
    // a thing at wall height rather than a piece of floor.
    return (
      <g>
        {box}
        {detail && h > 5 && (
          <line
            x1={2}
            y1={h / 2}
            x2={Math.max(2, w - 2)}
            y2={h / 2}
            stroke={stroke}
            strokeWidth={0.5}
            opacity={0.6}
          />
        )}
      </g>
    );
  }

  const special = SPECIAL[item.id];
  if (special && detail) return <g>{box}{special({ w, h, stroke })}</g>;
  return box;
}

/**
 * Per-item marks, keyed off real catalogue ids.
 *
 * Each returns detail drawn *inside* the footprint rect, which the caller has
 * already filled. These are the marks a drafter would make by hand: the pillow
 * end of a bed, the back of a sofa, the burners on a cooktop.
 */
const SPECIAL: Record<string, (m: MarkProps) => JSX.Element> = {
  // Beds: the head is a cross-band at the short end; the item's `width` is
  // across the bed and `depth` is head-to-foot, so the band sits at the top.
  'bed-double': pillowBand,
  'bed-queen': pillowBand,
  'bed-single': pillowBand,

  // Seating: a back band along the long side.
  'sofa-3': backBand,
  'sofa-2': backBand,
  armchair: backBand,

  wardrobe: (m) => <HangLines {...m} count={3} />,
  shelving: (m) => <HangLines {...m} count={2} />,
  'kitchen-run': (m) => <HangLines {...m} count={3} />,
  'tv-unit': (m) => <HangLines {...m} count={2} />,

  // Kitchen appliances.
  stove: Burners,
  sink: Bowl,
  basin: Bowl,
  fridge: (m) => <Split {...m} at={0.22} />,
  'washing-machine': Bowl,
  dryer: Bowl,

  // Bath.
  wc: Wc,
  bathtub: Bath,
  'bathtub-compact': Bath,
  'shower-corner': Shower,

  'dining-chair': (m) => <Split {...m} at={0.18} />,
  'dining-table': Chairs,

  // A rug is not a solid object; it is a field the furniture stands on.
  rug: ({ w, h, stroke }) => (
    <rect x={2} y={2} width={Math.max(0, w - 4)} height={Math.max(0, h - 4)} fill="none" stroke={stroke} strokeWidth={0.6} strokeDasharray="3 2" opacity={0.7} />
  ),
};

function pillowBand({ w, h, stroke }: MarkProps) {
  const band = Math.max(3, h * 0.22);
  const pillow = Math.max(2, w * 0.16);
  return (
    <g stroke={stroke} fill="none" strokeWidth={0.6} opacity={0.75}>
      <line x1={0} y1={band} x2={w} y2={band} />
      <rect x={pillow} y={1} width={Math.max(0, w - pillow * 2)} height={Math.max(0, band - 1.5)} rx={1.5} />
    </g>
  );
}

function backBand({ w, h, stroke }: MarkProps) {
  const band = Math.max(3, Math.min(h * 0.28, 12));
  return (
    <g stroke={stroke} fill="none" strokeWidth={0.6} opacity={0.75}>
      <line x1={0} y1={band} x2={w} y2={band} />
      <line x1={w / 3} y1={0} x2={w / 3} y2={band} />
      <line x1={(w * 2) / 3} y1={0} x2={(w * 2) / 3} y2={band} />
    </g>
  );
}

function HangLines({ w, h, stroke, count }: MarkProps & { count: number }) {
  const lines = [];
  for (let i = 1; i <= count; i++) {
    const x = (w * i) / (count + 1);
    lines.push(<line key={i} x1={x} y1={1.5} x2={x} y2={Math.max(1.5, h - 1.5)} stroke={stroke} strokeWidth={0.5} opacity={0.55} />);
  }
  return <g>{lines}</g>;
}

function Burners({ w, h, stroke }: MarkProps) {
  const r = Math.max(1.6, Math.min(w, h) * 0.13);
  const cx = w / 2;
  const cy = h / 2;
  const dx = w * 0.24;
  const dy = h * 0.24;
  return (
    <g stroke={stroke} fill="none" strokeWidth={0.55} opacity={0.8}>
      <circle cx={cx - dx} cy={cy - dy} r={r} />
      <circle cx={cx + dx} cy={cy - dy} r={r} />
      <circle cx={cx - dx} cy={cy + dy} r={r} />
      <circle cx={cx + dx} cy={cy + dy} r={r} />
    </g>
  );
}

function Bowl({ w, h, stroke }: MarkProps) {
  const inset = Math.max(1.5, Math.min(w, h) * 0.16);
  return (
    <rect
      x={inset}
      y={inset}
      width={Math.max(0, w - inset * 2)}
      height={Math.max(0, h - inset * 2)}
      rx={Math.max(1, Math.min(w, h) * 0.12)}
      fill="none"
      stroke={stroke}
      strokeWidth={0.55}
      opacity={0.8}
    />
  );
}

function Split({ w, h, stroke, at }: MarkProps & { at: number }) {
  return <line x1={0} y1={h * at} x2={w} y2={h * at} stroke={stroke} strokeWidth={0.6} opacity={0.7} />;
}

function Wc({ w, h, stroke }: MarkProps) {
  // Cistern at the top, bowl below — the plan convention, and the only part of
  // a toilet you actually recognise from above.
  const cistern = Math.max(2.5, h * 0.26);
  const rx = Math.max(1, w / 2 - 1);
  return (
    <g stroke={stroke} fill="none" strokeWidth={0.6} opacity={0.8}>
      <rect x={0.5} y={0.5} width={Math.max(0, w - 1)} height={cistern} />
      <ellipse cx={w / 2} cy={h * 0.62} rx={rx} ry={Math.max(1, h * 0.3)} />
    </g>
  );
}

function Bath({ w, h, stroke }: MarkProps) {
  // Rounded at one end, square at the other, with the waste drawn in.
  const r = Math.max(1.5, Math.min(w, h) * 0.28);
  return (
    <g stroke={stroke} fill="none" strokeWidth={0.6} opacity={0.8}>
      <rect x={1} y={1} width={Math.max(0, w - 2)} height={Math.max(0, h - 2)} rx={r} />
      <circle cx={r + 2} cy={h / 2} r={Math.max(0.8, r * 0.28)} />
    </g>
  );
}

function Shower({ w, h, stroke }: MarkProps) {
  const inset = Math.max(1.5, Math.min(w, h) * 0.14);
  const r = Math.max(1, Math.min(w, h) * 0.1);
  return (
    <g stroke={stroke} fill="none" strokeWidth={0.55} opacity={0.8}>
      <rect x={inset} y={inset} width={Math.max(0, w - inset * 2)} height={Math.max(0, h - inset * 2)} rx={r} />
      <line x1={inset} y1={inset} x2={w - inset} y2={h - inset} />
      <circle cx={w - inset - r * 1.6} cy={inset + r * 1.6} r={r} />
    </g>
  );
}

function Chairs({ w, h, stroke }: MarkProps) {
  const inset = Math.max(2.5, Math.min(w, h) * 0.2);
  const seatW = Math.max(0, w - inset * 2);
  const seatH = Math.max(0, h - inset * 2);
  const seat = (x: number, y: number, horizontal: boolean) => (
    <rect
      key={`${x}-${y}`}
      x={x}
      y={y}
      width={horizontal ? seatW : Math.max(3, seatH * 0.3)}
      height={horizontal ? Math.max(3, seatH * 0.3) : seatH}
      rx={1.5}
      fill="none"
      stroke={stroke}
      strokeWidth={0.5}
      opacity={0.65}
    />
  );
  return (
    <g>
      {seat(inset, (h - Math.max(3, seatH * 0.3)) / 2, true)}
      {seat(inset, 0, true)}
      {seat(inset, h - Math.max(3, seatH * 0.3), true)}
      {seat(0, inset, false)}
      {seat(w - Math.max(3, seatH * 0.3), inset, false)}
    </g>
  );
}