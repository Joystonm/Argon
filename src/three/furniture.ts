/**
 * Furniture as assemblies, not boxes.
 *
 * A sofa drawn as one box is not a sofa. It has a seat that sits lower than its
 * back, arms that are thinner than the frame they hang off, and cushions that
 * catch the light differently from the carcass — and all of that is the
 * difference between a room that looks furnished and a room that looks
 * *labelled*.
 *
 * So every catalogue item is described here as an assembly of small solids,
 * written the way a joiner would set it out: from the floor up, in millimetres
 * that come from the item's own footprint. Nothing here is downloaded or
 * imported: a modelled bed and a modelled bath are a few boxes and a few
 * cylinders apiece, which is enough to carry a silhouette and a set of
 * materials, and honest about being exactly that.
 *
 * ── The frame ─────────────────────────────────────────────────────────────────
 * Parts are given in the item's own frame: x across its width, z across its
 * depth, y up from the floor at the item's own origin. `buildScene` rotates the
 * whole assembly by the item's plan rotation, so nothing in this file has to
 * know which way the room faces.
 */
import type { FurnitureItem } from '../model/types.ts';

export interface Part {
  /** Centre of the part, in the item's local frame. */
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  /** Extra yaw about the part's own centre, degrees. */
  ry?: number;
  /** Extra pitch, degrees. Used for anything lying down rather than standing. */
  rx?: number;
  /** Extra roll, degrees. */
  rz?: number;
  shape: 'box' | 'cylinder' | 'sphere';
  /** Bevel radius. 0 means a hard architectural edge. */
  round: number;
  color: string;
  surface: string;
  roughness: number;
  metalness: number;
  opacity: number;
  glass: boolean;
  /** Whether the walk camera should be stopped by this part. */
  solid: boolean;
}

// ───────────────────────────────────────────────────────────────── palette ────

const WOOD = '#8a6a45';
const DARK_WOOD = '#6b4f34';
const PALE_WOOD = '#c2a67c';
const FABRIC = '#9d9a92';
const LINEN = '#e8e4da';
const WHITE = '#f0efec';
const STEEL = '#b9bdc1';
const DARK = '#3c3a37';
const GLASSY = '#20211f';
const SOIL = '#4a3f33';
const LEAF = '#5c7f52';
const ACCENT = '#b4564a';

const T = 0.018; // the thickness of a door front, a shelf, a worktop

// ────────────────────────────────────────────────────────────────── helpers ───

type Extra = Partial<Part>;

/** A box part, positioned by its **bottom face** — how a joiner measures. */
const box = (x: number, y: number, z: number, w: number, h: number, d: number, color: string, surface: string, extra: Extra = {}): Part => ({
  x,
  y: y + h / 2,
  z,
  w,
  h,
  d,
  shape: 'box',
  round: 0.01,
  color,
  surface,
  roughness: 0.85,
  metalness: 0,
  opacity: 1,
  glass: false,
  solid: true,
  ...extra,
});

/** A vertical cylinder. `d` is the diameter; it is the same in x and z. */
const cyl = (x: number, y: number, z: number, d: number, h: number, color: string, surface: string, extra: Extra = {}): Part => ({
  ...box(x, y, z, d, h, d, color, surface, extra),
  shape: 'cylinder',
  round: 0,
  roughness: 0.6,
});

const ball = (x: number, y: number, z: number, d: number, color: string, surface: string, extra: Extra = {}): Part => ({
  ...box(x, y, z, d, d, d, color, surface, extra),
  shape: 'sphere',
  round: 0,
});

/** Soft goods: bevelled generously and never shiny. */
const soft = (x: number, y: number, z: number, w: number, h: number, d: number, color: string, extra: Extra = {}): Part =>
  box(x, y, z, w, h, d, color, 'fabric', { round: Math.min(0.06, h / 2), roughness: 0.94, ...extra });

/** Four square legs at the corners of a footprint, inset a little. */
function legs(w: number, d: number, h: number, thickness: number, color = DARK_WOOD): Part[] {
  const inset = Math.min(w, d) / 2 - thickness * 1.6;
  return [
    [-inset, -inset],
    [inset, -inset],
    [-inset, inset],
    [inset, inset],
  ].map(([x, z]) => box(x!, 0, z!, thickness, h, thickness, color, 'oak', { solid: false, roughness: 0.7 }));
}

/** A run of door or drawer fronts across a carcass, with a handle on each. */
function fronts(
  w: number,
  d: number,
  y: number,
  h: number,
  count: number,
  color: string,
  surface: string,
  handleColor = STEEL,
): Part[] {
  const out: Part[] = [];
  const gap = 0.008;
  const panel = (w - gap * (count + 1)) / count;
  for (let i = 0; i < count; i++) {
    const x = -w / 2 + gap + panel / 2 + i * (panel + gap);
    out.push(box(x, y, d / 2 + T / 2, panel, h, T, color, surface, { round: 0.006 }));
    out.push(
      cyl(x, y + h * 0.72, d / 2 + T + 0.012, 0.016, h * 0.16, handleColor, 'metal', {
        solid: false,
        metalness: 0.85,
        roughness: 0.35,
      }),
    );
  }
  return out;
}

// ──────────────────────────────────────────────────────────────── assemblies ──

/**
 * A sofa. Seat lower than back, arms proud of the carcass, one cushion per
 * seat — the proportions that make the thing recognisable from across a room.
 */
function sofa(item: FurnitureItem, tint?: string): Part[] {
  const w = item.width;
  const d = item.depth;
  const h = item.height;
  const cloth = tint ?? FABRIC;
  const armW = Math.min(0.2, w / 5);
  const seatH = Math.min(0.42, h * 0.5);
  const seats = Math.max(1, Math.round((w - armW * 2) / 0.78));
  const inner = (w - armW * 2) / seats;

  const out: Part[] = [
    // Carcass, sitting on its own legs so the mass reads as raised.
    ...legs(w, d, 0.09, 0.05, DARK),
    soft(0, 0.09, 0, w, seatH - 0.09, d, cloth),
    // Back, full height, set against the rear edge.
    soft(0, 0.09, -d / 2 + 0.11, w, h - 0.09, 0.22, cloth),
  ];
  for (const side of [-1, 1]) {
    out.push(soft(side * (w / 2 - armW / 2), 0.09, 0, armW, h - 0.22, d, cloth));
  }
  for (let i = 0; i < seats; i++) {
    const x = -w / 2 + armW + inner * (i + 0.5);
    out.push(soft(x, seatH, 0.02, inner - 0.02, 0.15, d - 0.26, cloth, { solid: false }));
    out.push(soft(x, seatH + 0.15, -d / 2 + 0.24, inner - 0.04, h - seatH - 0.2, 0.15, cloth, { solid: false, round: 0.07 }));
  }
  return out;
}

/** An L-shaped sofa: the same build, plus a chaise running forward on one side. */
function sofaL(item: FurnitureItem, tint?: string): Part[] {
  const w = item.width;
  const d = item.depth;
  const h = item.height;
  const cloth = tint ?? FABRIC;
  const armW = Math.min(0.2, w / 5);
  const seatH = Math.min(0.42, h * 0.5);
  const backD = d * 0.6;

  const out: Part[] = [];
  const seats = Math.max(1, Math.round((w - armW * 2) / 0.78));
  const inner = (w - armW * 2) / seats;
  out.push(...legs(w, d, 0.09, 0.05, DARK));
  out.push(soft(0, 0.09, -d / 2 + backD / 2, w, seatH - 0.09, backD, cloth));
  out.push(soft(0, 0.09, -d / 2 + 0.11, w, h - 0.09, 0.22, cloth));
  out.push(soft(-(w / 2 - armW / 2), 0.09, -d / 2 + 0.11, armW, h - 0.09, 0.22, cloth));
  out.push(soft(w / 2 - armW / 2, 0.09, backD / 2 + d / 2 - backD / 2, armW, h - 0.22, d - 0.22, cloth));
  out.push(soft(w / 2 - armW, 0.09, -d / 2 + backD + (d - backD) / 2, armW, seatH - 0.09, d - backD, cloth));
  for (let i = 0; i < seats; i++) {
    const x = -w / 2 + armW + inner * (i + 0.5);
    out.push(soft(x, seatH, -d / 2 + backD / 2 + 0.02, inner - 0.02, 0.15, backD - 0.24, cloth, { solid: false }));
    out.push(soft(x, seatH + 0.15, -d / 2 + 0.24, inner - 0.04, h - seatH - 0.2, 0.15, cloth, { solid: false, round: 0.07 }));
  }
  return out;
}

/** A bed: frame, mattress, headboard, pillows, and a folded-back throw. */
function bed(item: FurnitureItem): Part[] {
  const w = item.width;
  const d = item.depth;
  const frameH = 0.26;
  const mattress = 0.24;
  const pillows = w > 1.2 ? 2 : 1;
  const out: Part[] = [
    box(0, 0, 0, w, frameH, d, WOOD, 'oak', { round: 0.012 }),
    soft(0, frameH, 0.01, w - 0.06, mattress, d - 0.06, LINEN, { round: 0.05, solid: false }),
    // The headboard is the one part taller than the catalogue height, because a
    // bed whose headboard stops at the top of the mattress is not a bed.
    box(0, frameH, -d / 2 + 0.05, w, 0.72, 0.1, WOOD, 'oak', { round: 0.02 }),
  ];
  for (let i = 0; i < pillows; i++) {
    const x = pillows === 1 ? 0 : (i - 0.5) * w * 0.44;
    out.push(soft(x, frameH + mattress, -d / 2 + 0.34, w * (pillows === 1 ? 0.6 : 0.4), 0.13, 0.34, '#f6f3ec', { round: 0.055, solid: false }));
  }
  out.push(soft(0, frameH + mattress, d * 0.16, w - 0.05, 0.09, d * 0.6, ACCENT, { round: 0.04, solid: false }));
  return out;
}

/** A kitchen counter run: recessed plinth, carcass, worktop, fronts, splashback. */
function counterRun(item: FurnitureItem, tone = '#d9d5cd', worktop = '#4b4a47'): Part[] {
  const w = item.width;
  const d = item.depth;
  const h = item.height;
  const doors = Math.max(1, Math.round(w / 0.6));
  const out: Part[] = [
    box(0, 0, 0, w - 0.08, 0.1, d - 0.06, '#3f3d3a', 'flat', { solid: false }),
    box(0, 0.1, 0, w, h - 0.06, d, tone, 'flat'),
    box(0, h - 0.05, 0.015, w + 0.02, 0.05, d + 0.03, worktop, 'stone', { round: 0.006, roughness: 0.42 }),
    ...fronts(w, d, 0.11, h - 0.17, doors, tone, 'flat'),
  ];
  return out;
}

/** The island is a counter run with a worktop that overhangs on both sides. */
function island(item: FurnitureItem): Part[] {
  const out = counterRun(item, '#cfccc5', '#55534f');
  const h = item.height;
  const top = out[2]!;
  top.w = item.width + 0.16;
  top.d = item.depth + 0.3;
  top.y = h - 0.025;
  // The seat side has no doors; a run of drawers reads better than blank panels.
  out.push(box(0, h - 0.05, -item.depth / 2 - 0.03, item.width + 0.1, 0.05, 0.06, '#55534f', 'stone', { solid: false, roughness: 0.42 }));
  return out;
}

/**
 * A wall cabinet. Hung at worktop height rather than stood on the floor,
 * because a "wall cabinet" resting on the floor is the single fastest way to
 * make a kitchen look like a diagram of one.
 */
function wallCabinet(item: FurnitureItem): Part[] {
  const w = item.width;
  const d = item.depth;
  const h = item.height;
  const y = 1.45;
  const doors = Math.max(1, Math.round(w / 0.6));
  return [
    box(0, y, 0, w, h, d, '#d5d2cc', 'flat', { round: 0.008 }),
    ...fronts(w, d, y + 0.02, h - 0.04, doors, '#dbd8d2', 'flat'),
    box(0, y - 0.004, d / 2 - 0.02, w - 0.06, 0.012, 0.04, '#fff6e2', 'flat', { solid: false, roughness: 0.4 }),
  ];
}

/** A tub, built as a shell so the inside is genuinely hollow. */
function bathtub(item: FurnitureItem): Part[] {
  const w = item.width;
  const d = item.depth;
  const h = item.height;
  const wall = 0.09;
  const out: Part[] = [
    box(0, 0, 0, w, 0.07, d, WHITE, 'flat', { round: 0.05 }),
    box(0, 0.07, -d / 2 + wall / 2, w, h - 0.07, wall, WHITE, 'flat', { round: 0.05 }),
    box(0, 0.07, d / 2 - wall / 2, w, h - 0.07, wall, WHITE, 'flat', { round: 0.05 }),
    box(-w / 2 + wall / 2, 0.07, 0, wall, h - 0.07, d - wall * 2, WHITE, 'flat', { round: 0.05 }),
    box(w / 2 - wall / 2, 0.07, 0, wall, h - 0.07, d - wall * 2, WHITE, 'flat', { round: 0.05 }),
    box(0, 0.07, 0, w - wall * 2, 0.02, d - wall * 2, '#e3e5e7', 'flat', { solid: false }),
  ];
  // Mixer at the wall end, which is where it always is.
  out.push(cyl(-w / 2 + 0.18, h, -d / 2 + 0.11, 0.05, 0.16, STEEL, 'metal', { solid: false, metalness: 0.9 }));
  out.push(cyl(-w / 2 + 0.18, h + 0.16, -d / 2 + 0.17, 0.028, 0.13, STEEL, 'metal', { solid: false, metalness: 0.9, rx: 90 }));
  return out;
}

/** A basin on a pedestal, with the bowl hollowed the same way as the tub. */
function basin(item: FurnitureItem): Part[] {
  const w = item.width;
  const d = item.depth;
  const h = item.height;
  const rim = 0.09;
  const rimY = h - 0.16;
  return [
    cyl(0, 0, 0, 0.16, rimY, WHITE, 'flat', { round: 0 }),
    box(0, rimY, 0, w, 0.16, d, WHITE, 'flat', { round: 0.04 }),
    box(0, rimY + 0.04, 0, w - rim * 2, 0.1, d - rim * 2, '#e6e8ea', 'flat', { solid: false }),
    cyl(w / 2 - 0.1, h, -d / 2 + 0.08, 0.035, 0.13, STEEL, 'metal', { solid: false, metalness: 0.9 }),
  ];
}

/** A panelled door: carcass, two leaves, and a pull on each. */
function wardrobe(item: FurnitureItem): Part[] {
  const w = item.width;
  const d = item.depth;
  const h = item.height;
  return [
    box(0, 0, 0, w - 0.06, 0.09, d - 0.06, '#3f3d3a', 'flat', { solid: false }),
    box(0, 0.09, 0, w, h - 0.09, d, '#cfc9c0', 'flat', { round: 0.008 }),
    box(-w / 4 - 0.008, 0.12, d / 2 + T / 2, w / 2 - 0.02, h - 0.15, T, WOOD, 'oak', { round: 0.006 }),
    box(w / 4 + 0.008, 0.12, d / 2 + T / 2, w / 2 - 0.02, h - 0.15, T, WOOD, 'oak', { round: 0.006 }),
    cyl(-0.03, h * 0.45, d / 2 + T + 0.012, 0.018, 0.22, STEEL, 'metal', { solid: false, metalness: 0.85, roughness: 0.35 }),
    cyl(0.03, h * 0.45, d / 2 + T + 0.012, 0.018, 0.22, STEEL, 'metal', { solid: false, metalness: 0.85, roughness: 0.35 }),
  ];
}

/** A four-legged table with a lower shelf. */
function table(item: FurnitureItem, shelf: boolean, thickness = 0.045): Part[] {
  const w = item.width;
  const d = item.depth;
  const h = item.height;
  const leg = Math.min(0.07, w / 12);
  const out: Part[] = [
    box(0, h - thickness, 0, w, thickness, d, WOOD, 'oak', { round: 0.01 }),
    box(0, h - thickness - 0.09, -d / 2 + leg / 2 + 0.01, w - leg * 2, 0.08, 0.025, WOOD, 'oak', { solid: false }),
    box(0, h - thickness - 0.09, d / 2 - leg / 2 - 0.01, w - leg * 2, 0.08, 0.025, WOOD, 'oak', { solid: false }),
    ...legs(w, d, h - thickness, leg, DARK_WOOD),
  ];
  if (shelf) out.push(box(0, Math.max(0.1, h * 0.28), 0, w - leg * 3, 0.025, d - leg * 3, WOOD, 'oak', { round: 0.008 }));
  return out;
}

/** A chair: seat, four legs, two back posts and a slat between them. */
function chair(item: FurnitureItem): Part[] {
  const w = item.width;
  const d = item.depth;
  const h = item.height;
  const seatY = h * 0.48;
  const leg = Math.min(0.045, w / 10);
  return [
    box(0, seatY - 0.04, 0, w, 0.04, d, WOOD, 'oak', { round: 0.012 }),
    ...legs(w, d, seatY, leg, DARK_WOOD),
    box(-w / 2 + leg / 2, seatY, -d / 2 + leg / 2, leg, h - seatY, leg, WOOD, 'oak', { solid: false }),
    box(w / 2 - leg / 2, seatY, -d / 2 + leg / 2, leg, h - seatY, leg, WOOD, 'oak', { solid: false }),
    box(0, seatY + (h - seatY) * 0.55, -d / 2 + leg / 2, w - leg * 1.6, 0.09, 0.022, WOOD, 'oak', { solid: false, round: 0.008 }),
  ];
}

/** A washing machine or dryer: body, round door, control panel. */
function appliance(item: FurnitureItem, tone = '#e7e5e0'): Part[] {
  const w = item.width;
  const d = item.depth;
  const h = item.height;
  const door = Math.min(w, d) * 0.52;
  return [
    box(0, 0, 0, w, h, d, tone, 'metal', { round: 0.012, metalness: 0.25, roughness: 0.45 }),
    cyl(0, (h - door) / 2, d / 2, door, 0.05, '#c9ccd0', 'metal', {
      solid: false,
      metalness: 0.7,
      roughness: 0.3,
      rx: 90,
    }),
    cyl(0, (h - door) / 2, d / 2 + 0.026, door * 0.68, 0.02, GLASSY, 'flat', { solid: false, roughness: 0.12, opacity: 0.85, rx: 90 }),
    box(0, h - 0.09, d / 2 + 0.008, w - 0.08, 0.09, 0.016, '#b9bcc0', 'metal', { solid: false, metalness: 0.6, roughness: 0.4 }),
  ];
}

/** A front-loader with a hob: body, oven door, four burners. */
function stove(item: FurnitureItem): Part[] {
  const w = item.width;
  const d = item.depth;
  const h = item.height;
  const burners: Part[] = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      burners.push(cyl(sx * w * 0.23, h, sz * d * 0.22, w * 0.24, 0.014, GLASSY, 'flat', { solid: false, roughness: 0.18, metalness: 0.2 }));
    }
  }
  return [
    box(0, 0, 0, w, h, d, '#dcdad5', 'metal', { round: 0.01, metalness: 0.2, roughness: 0.5 }),
    box(0, h, 0, w, 0.014, d, GLASSY, 'flat', { solid: false, roughness: 0.16, metalness: 0.2 }),
    ...burners,
    box(0, h * 0.22, d / 2 + 0.012, w - 0.09, h * 0.5, 0.02, GLASSY, 'flat', { solid: false, roughness: 0.14, opacity: 0.9 }),
    cyl(0, h * 0.72, d / 2 + 0.032, 0.02, w * 0.62, STEEL, 'metal', { solid: false, metalness: 0.9, roughness: 0.3, rz: 90 }),
    box(0, h - 0.07, d / 2 + 0.012, w - 0.1, 0.05, 0.014, '#9fa3a7', 'metal', { solid: false, metalness: 0.7 }),
  ];
}

/** A sink set into a counter, with a mixer tap. */
function sink(item: FurnitureItem): Part[] {
  const w = item.width;
  const d = item.depth;
  const h = item.height;
  const bw = w * 0.6;
  const bd = d * 0.6;
  return [
    box(0, 0.1, 0, w - 0.08, 0.1, d - 0.06, '#3f3d3a', 'flat', { solid: false }),
    box(0, 0.1, 0, w, h - 0.06, d, '#d9d5cd', 'flat'),
    box(0, h - 0.05, 0, w + 0.02, 0.05, d + 0.02, '#4b4a47', 'stone', { round: 0.006, roughness: 0.42 }),
    // The bowl is a shallow tray set into the worktop rather than a decal.
    box(0, h - 0.09, 0, bw, 0.06, bd, STEEL, 'metal', { solid: false, metalness: 0.85, roughness: 0.28 }),
    box(0, h - 0.045, 0, bw - 0.06, 0.02, bd - 0.06, '#8f9498', 'metal', { solid: false, metalness: 0.85, roughness: 0.22 }),
    cyl(0, h, -d / 2 + 0.1, 0.04, 0.26, STEEL, 'metal', { solid: false, metalness: 0.9, roughness: 0.3 }),
    cyl(0, h + 0.24, -d / 2 + 0.16, 0.024, 0.14, STEEL, 'metal', { solid: false, metalness: 0.9, roughness: 0.3, rx: 90 }),
  ];
}

/** A corner shower: tray, two glass screens, a frame, a head and a drain. */
function shower(item: FurnitureItem): Part[] {
  const w = item.width;
  const d = item.depth;
  const h = item.height;
  const glassT = 0.014;
  const out: Part[] = [
    box(0, 0, 0, w, 0.07, d, WHITE, 'tile', { round: 0.02 }),
    box(0, 0.05, 0, w - 0.14, 0.012, d - 0.14, '#d3d7d9', 'flat', { solid: false }),
  ];
  for (const side of [-1, 1]) {
    out.push(
      box((side * w) / 2, 0.07, 0, glassT, h - 0.07, d, '#cfe0e6', 'flat', {
        solid: false,
        glass: true,
        opacity: 0.24,
        roughness: 0.05,
      }),
    );
    out.push(box((side * w) / 2, 0.07, -d / 2 + 0.02, 0.03, h - 0.07, 0.03, STEEL, 'metal', { solid: false, metalness: 0.8 }));
  }
  out.push(cyl(0, h * 0.72, -d / 2 + 0.16, 0.03, 0.2, STEEL, 'metal', { solid: false, metalness: 0.85, rx: 90 }));
  out.push(cyl(0, h * 0.72, -d / 2 + 0.26, 0.14, 0.02, STEEL, 'metal', { solid: false, metalness: 0.85, rx: 90 }));
  return out;
}

/** A toilet: cistern, pedestal, bowl, seat and lid. */
function wc(item: FurnitureItem): Part[] {
  const w = item.width;
  const d = item.depth;
  const h = item.height;
  const bowlY = h * 0.53;
  return [
    cyl(0, 0, d * 0.06, 0.18, bowlY - 0.06, WHITE, 'flat', { round: 0 }),
    box(0, bowlY - 0.07, d * 0.04, w, 0.09, d - 0.16, WHITE, 'flat', { round: 0.05 }),
    box(0, bowlY + 0.02, d * 0.04, w - 0.05, 0.028, d - 0.2, '#f6f5f2', 'flat', { solid: false, round: 0.03 }),
    box(0, bowlY + 0.05, -d * 0.02, w - 0.07, 0.025, d - 0.34, '#f6f5f2', 'flat', { solid: false, round: 0.03 }),
    box(0, h - 0.36, -d / 2 + 0.09, w, 0.36, 0.18, WHITE, 'flat', { round: 0.03 }),
    cyl(0, h - 0.03, -d / 2 + 0.09, 0.04, 0.04, STEEL, 'metal', { solid: false, metalness: 0.85 }),
  ];
}

/** A shelf unit with a few things on it — an empty rack reads as scaffolding. */
function shelving(item: FurnitureItem): Part[] {
  const w = item.width;
  const d = item.depth;
  const h = item.height;
  const side = 0.028;
  const shelves = 5;
  const out: Part[] = [
    box(-w / 2 + side / 2, 0, 0, side, h, d, PALE_WOOD, 'oak', { solid: false }),
    box(w / 2 - side / 2, 0, 0, side, h, d, PALE_WOOD, 'oak', { solid: false }),
    box(0, 0, -d / 2 + 0.008, w - side * 2, h, 0.016, '#b6ac9c', 'flat', { solid: false }),
  ];
  for (let i = 0; i < shelves; i++) {
    const y = (h / (shelves + 1)) * (i + 1);
    out.push(box(0, y - 0.015, 0, w - side * 2, 0.03, d - 0.02, PALE_WOOD, 'oak', { solid: false }));
    if (i % 2 === 0) {
      const n = 3;
      for (let k = 0; k < n; k++) {
        out.push(
          box(
            -w * 0.3 + k * w * 0.3 + (k % 2) * 0.04,
            y + 0.015,
            0.02,
            w * 0.16,
            h * (0.09 + (k % 3) * 0.02),
            d * 0.6,
            ['#8a6f5a', '#6d7f86', '#9a8b74'][k]!,
            'flat',
            { solid: false, round: 0.01 },
          ),
        );
      }
    }
  }
  return out;
}

/** A potted plant. Foliage as a few overlapping spheres beats one box by a lot. */
function plant(item: FurnitureItem): Part[] {
  const w = item.width;
  const h = item.height;
  const potH = h * 0.22;
  const out: Part[] = [
    cyl(0, 0, 0, w * 0.62, potH, '#a9714c', 'flat', { round: 0 }),
    cyl(0, potH - 0.03, 0, w * 0.68, 0.05, '#8f5c3d', 'flat', { solid: false, round: 0 }),
    cyl(0, potH - 0.02, 0, w * 0.54, 0.03, SOIL, 'flat', { solid: false, round: 0 }),
  ];
  const canopy = h - potH;
  for (let i = 0; i < 3; i++) {
    const t = i / 2;
    out.push(cyl((i - 1) * w * 0.09, potH, 0, 0.022, canopy * (0.3 + t * 0.25), '#6b7a4e', 'leaf', { solid: false }));
  }
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    out.push(
      ball(Math.cos(a) * w * 0.19, potH + canopy * (0.4 + (i % 2) * 0.22), Math.sin(a) * w * 0.19, canopy * (0.52 - (i % 2) * 0.1), LEAF, 'leaf', {
        solid: false,
        round: 0,
      }),
    );
  }
  return out;
}

/** A rug with a border, so it does not read as a coloured rectangle. */
function rug(item: FurnitureItem): Part[] {
  const w = item.width;
  const d = item.depth;
  const h = Math.max(0.012, item.height);
  return [
    box(0, 0, 0, w, h, d, item.color ?? '#c2b6a2', 'fabric', { solid: false, roughness: 0.97, round: 0.004 }),
    box(0, h, 0, w - 0.2, 0.004, d - 0.2, '#9a8b74', 'fabric', { solid: false, roughness: 0.97, round: 0.002 }),
  ];
}

/** A tall cylinder with a cap and a pipe — a water heater, recognisably. */
function waterHeater(item: FurnitureItem): Part[] {
  const w = item.width;
  const h = item.height;
  return [
    cyl(0, 0, 0, w, h, '#e2e0db', 'metal', { round: 0, metalness: 0.35, roughness: 0.4 }),
    cyl(0, h, 0, w * 0.7, 0.06, '#c4c2bd', 'metal', { solid: false, round: 0, metalness: 0.4 }),
    cyl(w * 0.36, h * 0.86, 0, 0.03, h * 0.16, STEEL, 'metal', { solid: false, round: 0, metalness: 0.85 }),
    cyl(-w * 0.36, 0.02, 0, 0.03, h * 0.14, STEEL, 'metal', { solid: false, round: 0, metalness: 0.85 }),
  ];
}

/** A television unit: carcass, fronts, and a gap underneath. */
function tvUnit(item: FurnitureItem): Part[] {
  const w = item.width;
  const d = item.depth;
  const h = item.height;
  return [
    ...legs(w, d, 0.12, 0.04, DARK),
    box(0, 0.12, 0, w, h - 0.12, d, '#6d675e', 'oak', { round: 0.008 }),
    ...fronts(w, d, 0.15, h - 0.18, Math.max(2, Math.round(w / 0.6)), '#6d675e', 'oak'),
  ];
}

/** A desk: top, a pedestal of drawers, and legs. */
function desk(item: FurnitureItem): Part[] {
  const w = item.width;
  const d = item.depth;
  const h = item.height;
  const top = 0.04;
  const pedW = Math.min(0.42, w * 0.3);
  return [
    box(0, h - top, 0, w, top, d, PALE_WOOD, 'oak', { round: 0.01 }),
    box(w / 2 - pedW / 2 - 0.03, 0.02, 0, pedW, h - top - 0.04, d - 0.06, '#e4e1da', 'flat', { solid: false, round: 0.008 }),
    ...[0, 1, 2].map((i) =>
      box(w / 2 - pedW / 2 - 0.03, 0.06 + i * ((h - top) / 3), d / 2 - 0.02, pedW - 0.04, (h - top) / 3 - 0.04, 0.016, '#dcd9d2', 'flat', {
        solid: false,
        round: 0.005,
      }),
    ),
    ...legs(w, d, h - top, 0.055, DARK_WOOD).filter((p) => p.x < 0),
  ];
}

// ──────────────────────────────────────────────────────────────── dispatch ───

/**
 * The assembly for a catalogue item, in the item's own frame.
 *
 * Anything unrecognised falls back to a single bevelled box of the item's own
 * size. That is a deliberate floor rather than a hole: a furniture item the
 * catalogue gains next month should render as *a piece of furniture* before
 * anyone writes its assembly, not disappear.
 */
export function furnitureParts(item: FurnitureItem): Part[] {
  const tint = item.color;
  switch (item.catalogId) {
    case 'sofa-3':
    case 'sofa-2':
      return sofa(item, tint);
    case 'sofa-l':
      return sofaL(item, tint);
    case 'armchair':
      return sofa(item, tint);
    case 'coffee-table':
      return table(item, true, 0.04);
    case 'side-table':
      return table(item, true, 0.035);
    case 'dining-table':
      return table(item, false);
    case 'dining-chair':
      return chair(item);
    case 'bed-double':
    case 'bed-queen':
    case 'bed-single':
      return bed(item);
    case 'nightstand':
      return wardrobe({ ...item, height: Math.min(item.height, 0.6) });
    case 'wardrobe':
      return wardrobe(item);
    case 'kitchen-run':
      return counterRun(item);
    case 'kitchen-island':
      return island(item);
    case 'upper-cabinet':
      return wallCabinet(item);
    case 'fridge':
      return wardrobe(item);
    case 'stove':
      return stove(item);
    case 'sink':
      return sink(item);
    case 'bathtub':
    case 'bathtub-compact':
      return bathtub(item);
    case 'shower-corner':
      return shower(item);
    case 'basin':
      return basin(item);
    case 'wc':
      return wc(item);
    case 'washing-machine':
    case 'dryer':
      return appliance(item);
    case 'water-heater':
      return waterHeater(item);
    case 'shelving':
      return shelving(item);
    case 'plant-large':
      return plant(item);
    case 'rug':
      return rug(item);
    case 'tv-unit':
      return tvUnit(item);
    case 'desk':
      return desk(item);
    default:
      return [box(0, 0, 0, item.width, item.height, item.depth, tint ?? '#c9c2b1', 'flat', { round: 0.02 })];
  }
}