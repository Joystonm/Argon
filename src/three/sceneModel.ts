/**
 * Plan → 3D geometry.
 *
 * Nothing here is authored by hand: every box comes out of the canonical model,
 * which is what makes the 2D and 3D views the same building rather than two
 * drawings that happen to agree today.
 *
 * ── The mapping ──────────────────────────────────────────────────────────────
 *   plan (x, y)  →  world (x - plotWidth/2,  elevation,  y - plotDepth/2)
 *
 * Y already grows "south" in the plan, so it becomes +Z in the world with no
 * flip. Centring on the plot puts the building at the origin, which keeps the
 * orbit camera's default framing stable no matter how big the plot is.
 *
 * ── Openings ─────────────────────────────────────────────────────────────────
 * Doors and windows are cut by *splitting a wall into boxes*, not by CSG.
 * A wall with openings becomes a set of axis-aligned solids: a pier on each
 * side of each opening, a lintel above it, and (for windows) a sill below plus
 * a glass pane. That is exact, cheap, and cannot produce the broken geometry a
 * boolean subtract produces when two openings nearly touch.
 *
 * The splitting happens in the wall's own local frame: distances along the
 * centreline from point `a`. Walls in this model are axis-aligned, but the
 * frame is defined by the wall's actual direction rather than assumed, so a
 * non-axis-aligned wall splits into the right places instead of silently
 * producing one long box.
 */
import type { Floor, FurnitureItem, OutdoorSpace, Project, Room, RoomKind, Staircase, Wall } from '../model/types.ts';
import { furnitureParts } from './furniture.ts';

export interface Box {
  /** Centre, in world metres. */
  x: number;
  y: number;
  z: number;
  /** Full extents, in world metres. */
  w: number;
  h: number;
  d: number;
  /** Rotation about the vertical axis, degrees clockwise. */
  ry: number;
  color: string;
  roughness: number;
  metalness: number;
  opacity: number;
  /**
   * What this is, so a click can map a mesh back to a model id.
   *
   * `trim` and `frame` are the two purely-presentational kinds. They are kept
   * separate from `wall` and `glass` for a reason that is not cosmetic: the
   * test suite asserts *how many* wall and glass boxes a given model produces,
   * and a plinth that counted as wall would make those counts mean something
   * different from what they were written to mean. `colliders` is filtered on
   * these kinds too — a frame that stopped the camera would be worse than no
   * frame at all.
   */
  kind:
    | 'wall'
    | 'slab'
    | 'room-slab'
    | 'stair'
    | 'furniture'
    | 'deck'
    | 'railing'
    | 'roof'
    | 'glass'
    | 'trim'
    | 'frame'
    | 'lawn'
    | 'paving'
    | 'path';
  /** Id of the owning model element, when there is exactly one. */
  ownerId?: string;
  floorId: string;
  /**
   * Primitive to build this box from.
   *
   * `box` is right for anything architectural: a wall has arrises, and a
   * bevelled one does not. Furniture is the other way round — a cushion or a
   * cabinet front with a hard 90° edge reads as a block of modelling clay, so
   * its parts come from `furniture.ts` and arrive already bevelled.
   */
  shape?: 'box' | 'cylinder' | 'sphere';
  /** Bevel radius in metres. 0 or absent means hard edges. */
  round?: number;
  /** Extra pitch/roll in degrees, for anything not standing on its base. */
  rx?: number;
  rz?: number;
  /** Texture family — see `textures.ts`. Undefined means flat colour. */
  surface?: string;
  /** Render as glass: a physical material, not a tinted standard one. */
  glass?: boolean;
  /**
   * Excluded from walk-mode collision.
   *
   * Furniture is modelled as many small parts so it reads as furniture, and
   * most of those parts — cushions, handles, a plant's canopy — sit on or
   * inside something that is solid. Treating each of them as an obstacle would
   * mean the camera is stopped by a pillow before it reaches the sofa.
   */
  noCollide?: boolean;
}

export interface Collider {
  x: number;
  z: number;
  w: number;
  d: number;
  /**
   * The floor this collider belongs to.
   *
   * Collision is tested on the XZ plane only, so without it the first floor's
   * walls sit exactly on top of the ground floor's and a camera upstairs is
   * blocked by the furniture of the room *below* — which is what happened when
   * the second camera mode let the viewer walk between storeys.
   */
  floorId?: string;
}

export interface SceneGeometry {
  boxes: Box[];
  /** Opaque vertical obstacles for first-person collision. */
  colliders: Collider[];
  bounds: { width: number; depth: number; height: number };
  /**
   * The building itself, as opposed to the plot it stands on.
   *
   * Framing the camera on `bounds` — which is the *plot* — is why a house on a
   * generous plot sat small and off-centre in an empty field with the plot
   * boundary as the only other thing on screen. This is the extent that has
   * walls in it, and it is what the orbit camera should be looking at.
   */
  building: {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
    /** Centre of the footprint, at half height. A sensible orbit target. */
    cx: number;
    cz: number;
    cy: number;
    width: number;
    depth: number;
    height: number;
  };
  /**
   * The front door, derived rather than authored: the ground-floor door in the
   * exterior wall whose outward face points at the plot's street edge. The path
   * is drawn to it, so if the entrance moves the path moves with it.
   */
  entrance: { x: number; z: number; width: number } | null;
}

/**
 * The palette.
 *
 * Every value here is chosen to *separate* from its neighbours. The previous
 * set put the exterior wall, the roof, the parapet, the paving and the site all
 * within a few percent of the same cream, which is why the building read as one
 * undifferentiated slab: the eye finds edges through value contrast, and there
 * was none to find. The rule now is that anything meeting anything else at a
 * corner differs by enough luminance to draw its own line.
 */
const WALL_COLORS: Record<Wall['type'], string> = {
  exterior: '#efe9dd',
  interior: '#f6f2e9',
  parapet: '#cfc7b6',
  boundary: '#b9b2a3',
  railing: '#8e8778',
};

/** Dark joinery. Windows are read by their frames far more than by their glass. */
const FRAME_COLOR = '#5f574a';
const DOOR_FRAME_COLOR = '#6b6154';
const PLINTH_COLOR = '#a9a294';
const ROOF_COLOR = '#84837e';
const FASCIA_COLOR = '#8a8478';
const LAWN_COLOR = '#a8b48f';
const PAVING_COLOR = '#c6c0b2';
const PATH_COLOR = '#d2ccbe';

const KIND_FLOORS: Record<string, string> = {
  living: '#c9a87c',
  dining: '#c9a87c',
  kitchen: '#bfc4c6',
  bedroom: '#c8ab88',
  bathroom: '#cfd6d8',
  guest: '#c8ab88',
  office: '#c6b79c',
  prayer: '#c6b79c',
  storage: '#c4bfb6',
  utility: '#c4bfb6',
  pantry: '#c4bfb6',
  corridor: '#c4bfb6',
  hall: '#c4bfb6',
  lobby: '#c4bfb6',
  garage: '#b9b5ad',
  balcony: '#b9ae97',
  terrace: '#b9ae97',
};

const DEFAULT_FLOOR_COLOR = '#c4bfb6';
const GLASS_COLOR = '#a8ccdd';
const TREAD_COLOR = '#b9ae97';

// ─────────────────────────────────────────────────────────── surfaces ────────
/**
 * Which procedural texture each surface wears.
 *
 * The colours above say what a surface *is*; these say how it behaves. A tiled
 * bathroom floor, a boarded bedroom floor and a lawn are three different
 * materials that happen to share a value range, and without distinct texture
 * they render as one flat field that the eye reads as untextured. See
 * `textures.ts` for how each of these is generated.
 */
const WALL_SURFACE: Record<Wall['type'], string> = {
  exterior: 'render',
  interior: 'plaster',
  parapet: 'render',
  boundary: 'concrete',
  railing: 'metal',
};

/**
 * Floors by room kind. A wet room is tiled, a bedroom is boarded, a hall is
 * stone — which is both how houses are actually built and what stops every
 * ground-floor slab in the model looking like the same beige rectangle.
 */
const FLOOR_SURFACE: Record<RoomKind, string> = {
  living: 'stone',
  dining: 'oak',
  kitchen: 'tile',
  bedroom: 'oak',
  bathroom: 'tile',
  guest: 'oak',
  office: 'oak',
  prayer: 'tile',
  storage: 'concrete',
  utility: 'tile',
  pantry: 'tile',
  corridor: 'stone',
  hall: 'stone',
  lobby: 'stone',
  garage: 'concrete',
  balcony: 'paving',
  terrace: 'paving',
};

/** Height of the band that runs round the base of the elevation. */
export const PLINTH_HEIGHT = 0.45;
/** How far the plinth stands proud of the wall face, per side. */
const PLINTH_PROUD = 0.04;
/**
 * How far each solid piece of a wall runs past the joint on either side of it.
 *
 * Two boxes that stop exactly at a shared edge tile the screen perfectly in
 * exact arithmetic — the model puts them at the same coordinate and the
 * geometry puts the vertex at the same float — but they are still two separate
 * triangles from two separate draw calls, and a rasteriser that computes the
 * shared edge from different vertices can leave a sliver of a pixel covered by
 * neither. Multisampling does not paper over that: the uncovered samples are
 * filled from whatever is behind, so the sliver resolves as a hair of dark
 * interior. Every elevation came out dressed in dashed vertical hairlines at
 * every opening jamb and every piece joint, and turning antialiasing off made
 * them vanish completely — which is what identified it as coverage rather than
 * as a gap or a z-fight.
 *
 * Running each piece a couple of millimetres *under* its neighbours removes the
 * shared edge altogether. The overlap is far below a pixel at any sane viewing
 * distance, and the two faces it covers are coplanar with the same normal and
 * the same material, so there is nothing for the depth test to disagree about.
 */
export const JOINT_OVERLAP = 0.006;
/** How far the roof oversails the wall face. The shadow it casts is the line. */
export const EAVES_OVERHANG = 0.5;
const ROOF_THICKNESS = 0.24;
const FASCIA_HEIGHT = 0.2;

interface Frame {
  plotW: number;
  plotD: number;
  tx(x: number): number;
  tz(y: number): number;
}

export const frameFor = (plotW: number, plotD: number): Frame => ({
  plotW,
  plotD,
  tx: (x) => x - plotW / 2,
  tz: (y) => y - plotD / 2,
});

// ────────────────────────────────────────────────────────── wall junctions ───

/** How close two endpoints have to be to count as the same junction, in metres. */
const JOINT_EPS = 1e-3;

/** A corner where two walls meet at an angle, and the block that closes it. */
interface Corner {
  x: number;
  y: number;
  /** Half-extent of the closing block — a full wall thickness across. */
  half: number;
  height: number;
  color: string;
  surface: string;
  /** True when the plinth band should be continued round the corner too. */
  plinth: boolean;
  plinthHalf: number;
  floorId: string;
  baseY: number;
}

const samePoint = (a: { x: number; y: number }, b: { x: number; y: number }): boolean =>
  Math.abs(a.x - b.x) <= JOINT_EPS && Math.abs(a.y - b.y) <= JOINT_EPS;

/**
 * Resolve, once per storey, what each wall end runs into.
 *
 * Two walls meeting at 90° used to leave a thickness/2 × thickness/2 notch in
 * the outside corner: each wall box stopped on its own centreline, and nothing
 * filled the gap between them, so from outside you looked straight through the
 * slot into the interior. Every corner had a lit white seam running up it.
 *
 * The obvious repair — run each wall half a thickness *past* its endpoint —
 * trades that notch for something just as visible. Two boxes overlapping with
 * their outer faces exactly coplanar render with a one-pixel z-fight along the
 * overlap, so the corner became a bright stripe instead of a hole.
 *
 * The repair that actually holds is to give the corner its own solid: both
 * walls stop half a thickness short, and a block exactly one thickness square
 * fills the space between them. Its faces meet the walls' end faces edge to
 * edge, never face to face, and the end faces it meets point *into* the block —
 * so they are back-facing, culled, and cannot z-fight with anything.
 *
 * Walls that meet end-on along a straight line get no block and no trim: they
 * butt, their faces are back-to-back at the same plane, and neither is ever
 * drawn.
 */
function resolveCorners(walls: Wall[], floor: Floor, out: Corner[]): Map<string, number> {
  /** `${wallId}:a|b` → how far that end pulls back, in metres. */
  const trim = new Map<string, number>();
  /** Junction point → half-extent of the block that fills it. */
  const halfAt = new Map<string, number>();

  for (const w of walls) {
    if (w.type === 'railing' || w.type === 'boundary') {
      trim.set(`${w.id}:a`, 0);
      trim.set(`${w.id}:b`, 0);
      continue;
    }
    const own = { x: w.b.x - w.a.x, y: w.b.y - w.a.y };
    const ownLen = Math.hypot(own.x, own.y) || 1;

    for (const end of ['a', 'b'] as const) {
      const p = w[end];
      // Every wall arriving at this junction, not just the first one found.
      const joined = walls.filter((o) => {
        if (o.id === w.id) return false;
        if (o.type === 'railing' || o.type === 'boundary') return false;
        if (!samePoint(o.a, p) && !samePoint(o.b, p)) return false;
        const other = { x: o.b.x - o.a.x, y: o.b.y - o.a.y };
        const otherLen = Math.hypot(other.x, other.y) || 1;
        // Collinear: a straight run of wall. Nothing to bridge.
        const cross = Math.abs((own.x * other.y - own.y * other.x) / (ownLen * otherLen));
        return cross >= 1e-6;
      });
      if (!joined.length) {
        trim.set(`${w.id}:${end}`, 0);
        continue;
      }

      const key = `${floor.id}:${p.x.toFixed(3)}:${p.y.toFixed(3)}`;
      let half = halfAt.get(key);
      if (half === undefined) {
        // The thickest wall at the junction sets the block, so that a thin
        // partition arriving at an exterior corner still stops on the block's
        // face rather than poking a few millimetres out past it.
        const thickest = joined.reduce((a, o) =>
          Math.max(0.05, o.type === 'exterior' ? o.thickness : Math.max(w.thickness, o.thickness)) >
          Math.max(0.05, a.type === 'exterior' ? a.thickness : Math.max(w.thickness, a.thickness))
            ? o
            : a,
        );
        const exterior = w.type === 'exterior' || thickest.type === 'exterior';
        const thickness = exterior
          ? Math.max(0.05, w.type === 'exterior' ? w.thickness : thickest.thickness)
          : Math.max(0.05, Math.max(w.thickness, thickest.thickness));
        half = thickness / 2;
        halfAt.set(key, half);
        out.push({
          x: p.x,
          y: p.y,
          half,
          // The shortest wall here decides: a corner block taller than its walls
          // would stand above the eaves.
          height: Math.min(
            Math.max(0.1, w.height || floor.height),
            ...joined.map((o) => Math.max(0.1, o.height || floor.height)),
          ),
          color: exterior ? WALL_COLORS.exterior : WALL_COLORS[w.type] ?? WALL_COLORS.interior,
          surface: exterior ? WALL_SURFACE.exterior : WALL_SURFACE[w.type] ?? WALL_SURFACE.interior,
          plinth: floor.order === 0 && (w.type === 'exterior' || joined.some((o) => o.type === 'exterior')),
          plinthHalf: half + PLINTH_PROUD,
          floorId: floor.id,
          baseY: floor.elevation,
        });
      }
      trim.set(`${w.id}:${end}`, half);
    }
  }
  return trim;
}

/**
 * Split one wall into solid boxes around its openings.
 *
 * `s0`/`s1` are distances along the centreline from point `a`; `y0`/`y1` are
 * heights above the storey datum. Both axes are transformed with the wall's
 * own direction vector, so the split is correct for any wall orientation.
 */
function wallBoxes(wall: Wall, f: Frame, floor: Floor, trims: Map<string, number>, out: Box[]): void {
  const dx = wall.b.x - wall.a.x;
  const dy = wall.b.y - wall.a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return;

  const ux = dx / len;
  const uy = dy / len;
  const thickness = Math.max(0.05, wall.thickness);
  const height = Math.max(0.1, wall.height || floor.height);
  const baseY = floor.elevation;
  const ry = (Math.atan2(dy, dx) * 180) / Math.PI;

  /**
   * A box spanning [s0,s1] along the wall and [y0,y1] in height.
   *
   * `depth` overrides the wall thickness — joinery is proud of both wall faces
   * by a couple of centimetres, which is the only reason a frame is visible at
   * all on a wall that is itself only 20 cm thick.
   */
  const push = (
    s0: number,
    s1: number,
    y0: number,
    y1: number,
    kind: Box['kind'],
    color: string,
    opts: { opacity?: number; depth?: number; roughness?: number; metalness?: number; surface?: string; glass?: boolean } = {},
  ) => {
    const ds = s1 - s0;
    const dyh = y1 - y0;
    if (ds < 1e-4 || dyh < 1e-4) return;
    const sm = (s0 + s1) / 2;
    const cx = wall.a.x + ux * sm;
    const cy = wall.a.y + uy * sm;
    out.push({
      x: f.tx(cx),
      y: baseY + (y0 + y1) / 2,
      z: f.tz(cy),
      w: ds,
      h: dyh,
      d: opts.depth ?? thickness,
      ry,
      color,
      roughness: opts.roughness ?? 0.92,
      metalness: opts.metalness ?? 0,
      opacity: opts.opacity ?? 1,
      kind,
      ownerId: wall.id,
      floorId: wall.floorId,
      surface: opts.surface ?? WALL_SURFACE[wall.type],
      glass: opts.glass,
    });
  };

  if (wall.type === 'railing' || wall.type === 'boundary') {
    push(0, len, 0, height, 'railing', WALL_COLORS[wall.type], { metalness: 0.35, roughness: 0.55 });
    return;
  }

  const color = WALL_COLORS[wall.type];
  const openings = [...wall.openings].sort((a, b) => a.offset - b.offset);
  // A plinth is a base band, so it belongs to the storey that sits on the
  // ground and to nothing above it. It also runs a little proud of the wall,
  // which is what puts a shadow line along the bottom of the elevation.
  const plinth = floor.order === 0 && wall.type === 'exterior';
  const plinthH = Math.min(PLINTH_HEIGHT, height * 0.4);
  const plinthDepth = thickness + PLINTH_PROUD * 2;

  // Each end of the wall stops short of a corner by half a thickness, and the
  // gap is filled by a block owned by neither wall. See `resolveCorners` for
  // why oversailing instead — the obvious fix — trades a hole for a z-fight.
  const backA = trims.get(`${wall.id}:a`) ?? 0;
  const backB = trims.get(`${wall.id}:b`) ?? 0;
  const s0 = (v: number) => (v <= 1e-6 ? backA : v);
  const s1 = (v: number) => (v >= len - 1e-6 ? len - backB : v);

  // The plinth pulls back further than the wall does, by exactly its own
  // proudness, because the corner block's plinth is proud on the same amount.
  // Stopping both at the wall's line instead leaves the two plinths overlapping
  // by four centimetres with their outer faces coplanar — the same z-fight the
  // wall above was carefully arranged to avoid, four centimetres lower down.
  const p0 = (v: number) => (v <= 1e-6 ? backA + PLINTH_PROUD : v);
  const p1 = (v: number) => (v >= len - 1e-6 ? len - backB - PLINTH_PROUD : v);

  /**
   * One solid piece of the elevation, run past its joints on both sides.
   *
   * Clamped to the wall's own extent, so a wall that simply stops in the open
   * still stops — but a piece that meets a corner block reaches two millimetres
   * inside it, which is what takes the hairline off that joint too.
   */
  const piece = (from: number, to: number, y0: number, y1: number) =>
    push(Math.max(0, from - JOINT_OVERLAP), Math.min(len, to + JOINT_OVERLAP), y0, y1, 'wall', color);

  const pushPlinth = (from: number, to: number, upTo: number) => {
    if (!plinth) return;
    const top = Math.min(upTo, plinthH);
    if (top > 0.02) {
      push(Math.max(0, from - JOINT_OVERLAP), Math.min(len, to + JOINT_OVERLAP), 0, top, 'trim', PLINTH_COLOR, {
        depth: plinthDepth,
        roughness: 0.88,
        surface: 'stone',
      });
    }
  };

  if (!openings.length) {
    piece(s0(0), s1(len), 0, height);
    pushPlinth(p0(0), p1(len), height);
    return;
  }

  // Every piece is the *full* wall thickness, so the elevation is one
  // continuous plane from end to end — and every piece runs a couple of
  // millimetres under its neighbours, so the plane has no seams in it either.
  // See `JOINT_OVERLAP`.
  //
  // Setting the sill and head pieces *back* by a few millimetres instead — which
  // this did once — put a 6 mm step down the full height of every pier, at every
  // opening jamb. At any real viewing distance that step is far thinner than a
  // pixel but its shaded inner face still lands on one, so every elevation came
  // out decorated with a row of dark hairlines running from the plinth to the
  // eaves. Overlapping keeps every face on the one plane.

  let cursor = 0;
  for (const o of openings) {
    const start = Math.max(0, o.offset - o.width / 2);
    const end = Math.min(len, o.offset + o.width / 2);
    // Pier from the last opening (or the wall start) up to this one.
    if (start > cursor) {
      piece(s0(cursor), s1(start), 0, height);
      pushPlinth(p0(cursor), p1(start), height);
    }

    const head = Math.min(height, o.sill + o.height);
    if (o.sill > 0.01) {
      piece(s0(start), s1(end), 0, o.sill);
      pushPlinth(p0(start), p1(end), o.sill);
    }
    if (head < height - 0.01) piece(s0(start), s1(end), head, height);

    // Joinery. A window with no frame is a hole; a window with a dark frame,
    // a mullion and a proud sill reads as a window from across the site.
    const joineryDepth = thickness + 0.06;
    const fw = 0.055;
    const y0 = o.kind === 'window' ? o.sill : 0;
    const y1 = Math.min(o.sill + o.height, height);
    const isDoor = o.kind !== 'window';

    // Jambs, set just inside the reveal so they do not narrow the clear opening
    // by their own width on top of the wall that already does.
    push(start, start + fw, y0, y1, 'frame', isDoor ? DOOR_FRAME_COLOR : FRAME_COLOR, { depth: joineryDepth, roughness: 0.55 });
    push(end - fw, end, y0, y1, 'frame', isDoor ? DOOR_FRAME_COLOR : FRAME_COLOR, { depth: joineryDepth, roughness: 0.55 });
    // Head, plus a sill for windows and a threshold for doors.
    push(start, end, y1 - fw, y1, 'frame', isDoor ? DOOR_FRAME_COLOR : FRAME_COLOR, { depth: joineryDepth, roughness: 0.55 });
    if (o.kind === 'window') {
      push(start, end, y0, y0 + fw, 'trim', PLINTH_COLOR, { depth: thickness + 0.14, roughness: 0.85 });
      // One central mullion on anything wide enough to need one, so a 2.4 m
      // opening does not read as a single sheet of glass.
      if (end - start > 1.15) {
        const m = (start + end) / 2;
        push(m - 0.03, m + 0.03, y0, y1, 'frame', FRAME_COLOR, { depth: joineryDepth, roughness: 0.55 });
      }
    }

    if (o.kind === 'window') push(start, end, o.sill, y1, 'glass', GLASS_COLOR, { opacity: 0.3, roughness: 0.05, metalness: 0.1, glass: true, surface: undefined });

    cursor = Math.max(cursor, end);
  }
  if (cursor < len) {
    piece(s0(cursor), s1(len), 0, height);
    pushPlinth(p0(cursor), p1(len), height);
  }
}

function roomSlab(room: Room, f: Frame, floor: Floor, thickness: number, out: Box[]): void {
  out.push({
    x: f.tx(room.x + room.width / 2),
    y: floor.elevation - thickness / 2,
    z: f.tz(room.y + room.depth / 2),
    w: room.width,
    h: thickness,
    d: room.depth,
    ry: 0,
    color: KIND_FLOORS[room.kind] ?? DEFAULT_FLOOR_COLOR,
    roughness: 0.86,
    metalness: 0,
    opacity: 1,
    kind: 'room-slab',
    ownerId: room.id,
    floorId: room.floorId,
    surface: FLOOR_SURFACE[room.kind] ?? 'flat',
  });
}

/**
 * Stairs as discrete treads over a solid core.
 *
 * Real treads rather than a ramp: the count is what tells you the flight is
 * climbable at a believable slope, and the model is what the validator checks.
 */
function stairBoxes(stair: Staircase, f: Frame, floor: Floor, out: Box[]): void {
  const rise = stair.rise ?? floor.height;
  const count = Math.max(2, Math.round(stair.riserCount));
  const riser = rise / count;
  const going = stair.run / count;
  // `direction` is +1 when the flight ascends away from this storey (it leaves
  // this floor and arrives at `connectsToFloorId`) and -1 when it descends out
  // of it. An ascending flight therefore starts *on* this floor, and only a
  // descending one starts below it.
  const baseY = stair.direction === 1 ? floor.elevation : floor.elevation - rise;
  const tread = 0.05;
  const startPlanY = stair.y - stair.run / 2;

  for (let i = 0; i < count; i++) {
    const along = stair.direction === 1 ? (i + 0.5) * going : stair.run - (i + 0.5) * going;
    out.push({
      x: f.tx(stair.x),
      y: baseY + (i + 1) * riser - tread / 2,
      z: f.tz(startPlanY + along),
      w: stair.width,
      h: tread,
      d: going,
      ry: 0,
      color: TREAD_COLOR,
      roughness: 0.85,
      metalness: 0,
      opacity: 1,
      kind: 'stair',
      ownerId: stair.id,
      floorId: stair.floorId,
      surface: 'oak',
    });
  }

  out.push({
    x: f.tx(stair.x),
    y: baseY + rise / 2 - 0.08,
    z: f.tz(stair.y),
    w: stair.width * 0.9,
    h: Math.max(0.1, rise - 0.1),
    d: stair.run,
    ry: 0,
    color: '#a89d88',
    roughness: 0.95,
    metalness: 0,
    opacity: 1,
    kind: 'stair',
    ownerId: stair.id,
    floorId: stair.floorId,
    surface: 'render',
  });
}

/**
 * One catalogue item as an assembly of parts, placed in the world.
 *
 * The parts come from `furniture.ts` in the item's own frame — x across its
 * width, z across its depth, y up from its floor — and are rotated as a group
 * here. Rotating each part about the *item's* origin rather than about its own
 * is what puts a sofa's back against the wall when the plan says the sofa faces
 * the other way; the rotation is applied once, to the part's offset, and once
 * more to the part itself as its yaw.
 */
function furnitureBoxes(item: FurnitureItem, f: Frame, floor: Floor, out: Box[]): void {
  const rad = (item.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  for (const p of furnitureParts(item)) {
    const px = p.x * cos + p.z * sin;
    const pz = -p.x * sin + p.z * cos;
    const solid = p.solid && p.h > 0.03;
    out.push({
      x: f.tx(item.x + px),
      y: floor.elevation + p.y,
      z: f.tz(item.y + pz),
      w: Math.max(0.01, p.w),
      h: Math.max(0.01, p.h),
      d: Math.max(0.01, p.d),
      ry: item.rotation + (p.ry ?? 0),
      color: p.color,
      roughness: p.roughness,
      metalness: p.metalness,
      opacity: p.opacity,
      kind: 'furniture',
      ownerId: item.id,
      floorId: item.floorId,
      shape: p.shape,
      round: p.round,
      rx: p.rx,
      rz: p.rz,
      surface: p.surface,
      glass: p.glass,
      // Non-solid parts are decoration sitting on or inside something solid.
      // They still render — a pillow is visible — they just do not stop the
      // camera, which would otherwise meet a footstool before the sofa.
      noCollide: solid ? undefined : true,
    });
  }
}

function outdoorBoxes(o: OutdoorSpace, f: Frame, floor: Floor, out: Box[]): void {
  const y = floor.elevation + o.elevationOffset;
  const x0 = o.x - o.width / 2;
  const z0 = o.y - o.depth / 2;
  out.push({
    x: f.tx(o.x),
    y: y - 0.06,
    z: f.tz(o.y),
    w: o.width,
    h: 0.12,
    d: o.depth,
    ry: 0,
    color: TREAD_COLOR,
    roughness: 0.9,
    metalness: 0,
    opacity: 1,
    kind: 'deck',
    ownerId: o.id,
    floorId: o.floorId,
    surface: 'oak',
  });

  const h = Math.max(0.3, o.railingHeight);
  const post = 0.06;
  const rails: Array<[number, number, number, number]> = [
    [0, 0, o.width, post],
    [0, o.depth - post, o.width, post],
    [0, 0, post, o.depth],
    [o.width - post, 0, post, o.depth],
  ];
  for (const [rx, rz, rw, rd] of rails) {
    out.push({
      x: f.tx(x0 + rx + rw / 2),
      y: y + h / 2,
      z: f.tz(z0 + rz + rd / 2),
      w: rw,
      h,
      d: rd,
      ry: 0,
      color: '#8d8577',
      roughness: 0.5,
      metalness: 0.4,
      opacity: 1,
      kind: 'railing',
      ownerId: o.id,
      floorId: o.floorId,
      surface: 'metal',
    });
  }
}

/**
 * Flat roof over the topmost storey, oversailing the wall line.
 *
 * This replaced a parapet that sat flush with the walls, which from any angle
 * above eye level read as an open tray: the roof plane, the parapet and the
 * walls were all the same cream and all the same height, so the building had no
 * top edge at all. Oversailing by half a metre puts the roof in its own shadow
 * and casts a hard line along the elevation, and the fascia below it gives that
 * line a third tone to fall against.
 */
function roofBoxes(rooms: Room[], walls: Wall[], f: Frame, floor: Floor, out: Box[]): void {
  if (!rooms.length && !walls.length) return;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  // Exterior walls sit on the room boundary, so including them guarantees the
  // roof covers the wall footprint rather than stopping at the inner face.
  for (const r of rooms) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.depth);
  }
  for (const w of walls) {
    if (w.type !== 'exterior') continue;
    minX = Math.min(minX, w.a.x, w.b.x);
    minY = Math.min(minY, w.a.y, w.b.y);
    maxX = Math.max(maxX, w.a.x, w.b.x);
    maxY = Math.max(maxY, w.a.y, w.b.y);
  }
  if (!Number.isFinite(minX) || maxX <= minX || maxY <= minY) return;

  const w = maxX - minX + EAVES_OVERHANG * 2;
  const d = maxY - minY + EAVES_OVERHANG * 2;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  // The deck sits on top of the wall head; the fascia hangs below it.
  const top = floor.elevation + floor.height + ROOF_THICKNESS;

  out.push({
    x: f.tx(cx),
    y: top - ROOF_THICKNESS / 2,
    z: f.tz(cy),
    w,
    h: ROOF_THICKNESS,
    d,
    ry: 0,
    color: ROOF_COLOR,
    roughness: 0.96,
    metalness: 0,
    opacity: 1,
    kind: 'roof',
    floorId: floor.id,
    surface: 'roof',
  });

  const halfW = w / 2;
  const halfD = d / 2;
  const fascia: Array<[number, number, number, number]> = [
    [cx - halfW, cy - halfD, w, 0.07],
    [cx - halfW, cy + halfD - 0.07, w, 0.07],
    [cx - halfW, cy - halfD, 0.07, d],
    [cx + halfW - 0.07, cy - halfD, 0.07, d],
  ];
  for (const [fx, fz, fw, fd] of fascia) {
    out.push({
      x: f.tx(fx + fw / 2),
      y: top - ROOF_THICKNESS - FASCIA_HEIGHT / 2,
      z: f.tz(fz + fd / 2),
      w: fw,
      h: FASCIA_HEIGHT,
      d: fd,
      ry: 0,
      color: FASCIA_COLOR,
      roughness: 0.9,
      metalness: 0,
      opacity: 1,
      kind: 'roof',
      floorId: floor.id,
      surface: 'flat',
    });
  }
}

/**
 * The blocks that close a junction.
 *
 * Two per corner: one for the wall, one for the plinth. The plinth is proud of
 * the wall face by four centimetres, so a wall-sized block would leave the base
 * band open at exactly the same place the wall corner was open before — the
 * seam would simply move down to the bottom of the elevation and become a
 * stripe in the plinth instead.
 */
function cornerBoxes(corners: Corner[], f: Frame, out: Box[]): void {
  for (const c of corners) {
    const full = c.half * 2;
    if (c.plinth) {
      const plinthH = Math.min(PLINTH_HEIGHT, c.height * 0.4);
      if (plinthH > 0.02) {
        out.push({
          x: f.tx(c.x),
          y: c.baseY + plinthH / 2,
          z: f.tz(c.y),
          w: c.plinthHalf * 2,
          h: plinthH,
          d: c.plinthHalf * 2,
          ry: 0,
          color: PLINTH_COLOR,
          roughness: 0.88,
          metalness: 0,
          opacity: 1,
          kind: 'trim',
          floorId: c.floorId,
          surface: 'stone',
        });
      }
      const above = c.height - plinthH;
      if (above > 0.02) {
        out.push({
          x: f.tx(c.x),
          y: c.baseY + plinthH + above / 2,
          z: f.tz(c.y),
          w: full,
          h: above,
          d: full,
          ry: 0,
          color: c.color,
          roughness: 0.92,
          metalness: 0,
          opacity: 1,
          kind: 'trim',
          floorId: c.floorId,
          surface: c.surface,
        });
      }
      continue;
    }
    out.push({
      x: f.tx(c.x),
      y: c.baseY + c.height / 2,
      z: f.tz(c.y),
      w: full,
      h: c.height,
      d: full,
      ry: 0,
      color: c.color,
      roughness: 0.92,
      metalness: 0,
      opacity: 1,
      kind: 'trim',
      floorId: c.floorId,
      surface: c.surface,
    });
  }
}

export interface BuildOptions {
  /** Which floors to include. Undefined means every floor. */
  visibleFloorIds?: string[];
  showRoof?: boolean;
  showFurniture?: boolean;
  showGround?: boolean;
}

export function buildScene(project: Project, options: BuildOptions = {}): SceneGeometry {
  const { showRoof = true, showFurniture = true, showGround = true } = options;
  const f = frameFor(project.plot.width, project.plot.depth);
  const boxes: Box[] = [];

  const allFloors = project.floors.slice().sort((a, b) => a.order - b.order);
  const topFloor = allFloors[allFloors.length - 1];
  const floors = allFloors.filter((x) => (options.visibleFloorIds?.length ? options.visibleFloorIds.includes(x.id) : true));

  for (const floor of floors) {
    const rooms = project.rooms.filter((r) => r.floorId === floor.id);
    const walls = project.walls.filter((w) => w.floorId === floor.id);

    if (floor.order === 0 && showGround) {
      const sb = project.plot.setbacks;
      const bw = Math.max(0, project.plot.width - sb.left - sb.right);
      const bd = Math.max(0, project.plot.depth - sb.front - sb.rear);
      boxes.push({
        x: f.tx(sb.left + bw / 2),
        y: -0.09,
        z: f.tz(sb.front + bd / 2),
        w: bw,
        h: 0.18,
        d: bd,
        ry: 0,
        color: PAVING_COLOR,
        roughness: 0.95,
        metalness: 0,
        opacity: 1,
        kind: 'slab',
        floorId: floor.id,
        surface: 'paving',
      });
    }

    const corners: Corner[] = [];
    const trims = resolveCorners(walls, floor, corners);

    for (const r of rooms) roomSlab(r, f, floor, 0.2, boxes);
    for (const w of walls) wallBoxes(w, f, floor, trims, boxes);
    cornerBoxes(corners, f, boxes);
    for (const s of project.stairs.filter((x) => x.floorId === floor.id)) stairBoxes(s, f, floor, boxes);
    for (const o of project.outdoor.filter((x) => x.floorId === floor.id)) outdoorBoxes(o, f, floor, boxes);
    if (showFurniture) {
      for (const item of project.furniture.filter((x) => x.floorId === floor.id)) furnitureBoxes(item, f, floor, boxes);
    }
    if (showRoof && topFloor && floor.id === topFloor.id) roofBoxes(rooms, walls, f, floor, boxes);
  }

  // Collision volumes: opaque walls and furniture only. Slabs, stairs, decks
  // and railings are walkable or harmless — a camera that bumps into a window
  // pane but walks through a deck would be worse than no collision at all.
  // Glass is treated as a wall because you should not walk through a window.
  // Corner blocks are deliberately absent: they are flush with the two walls
  // they join, so the walls themselves already block that square of floor.
  const colliders = boxes
    .filter((b) => (b.kind === 'wall' || b.kind === 'furniture' || b.kind === 'glass') && !b.noCollide)
    .map((b) => ({ x: b.x, z: b.z, w: b.w, d: b.d, floorId: b.floorId }));

  const building = buildingExtent(boxes);
  const entrance = findEntrance(project, f);
  siteBoxes(project, building, entrance, boxes);

  let maxY = 0;
  for (const b of boxes) if (b.kind !== 'lawn' && b.kind !== 'paving' && b.kind !== 'path') maxY = Math.max(maxY, b.y + b.h / 2);

  return {
    boxes,
    colliders,
    bounds: { width: project.plot.width, depth: project.plot.depth, height: maxY },
    building,
    entrance,
  };
}

/**
 * The extent of the built fabric, as opposed to the plot.
 *
 * Only walls count. Slabs, decks and the roof all oversail or under-run the
 * wall line, so including them would hand the camera a target that is already
 * wrong by the width of an eaves overhang — and a plan with no walls yet (a
 * fresh empty plot) correctly produces an empty extent rather than the whole
 * site, which is what stops the camera framing a building that does not exist.
 */
function buildingExtent(boxes: Box[]): SceneGeometry['building'] {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let maxY = 0;
  for (const b of boxes) {
    if (b.kind !== 'wall') continue;
    // `ry` is the wall's own heading, so its world footprint is the box extent
    // rotated about its centre. Walls are axis-aligned by construction, but the
    // swap below costs nothing and keeps this honest if that ever changes.
    const swap = Math.abs(Math.sin((b.ry * Math.PI) / 180)) > 0.5;
    const hw = (swap ? b.d : b.w) / 2;
    const hd = (swap ? b.w : b.d) / 2;
    minX = Math.min(minX, b.x - hw);
    maxX = Math.max(maxX, b.x + hw);
    minZ = Math.min(minZ, b.z - hd);
    maxZ = Math.max(maxZ, b.z + hd);
    maxY = Math.max(maxY, b.y + b.h / 2);
  }
  if (!Number.isFinite(minX)) {
    // No walls: fall back to the plot centre so the camera still has a target.
    return {
      minX: 0,
      maxX: 0,
      minZ: 0,
      maxZ: 0,
      cx: 0,
      cz: 0,
      cy: 0,
      width: 0,
      depth: 0,
      height: 0,
    };
  }
  return {
    minX,
    maxX,
    minZ,
    maxZ,
    cx: (minX + maxX) / 2,
    cz: (minZ + maxZ) / 2,
    cy: maxY / 2,
    width: maxX - minX,
    depth: maxZ - minZ,
    height: maxY,
  };
}

/**
 * The ground the building stands on: lawn, a paved apron against the elevation,
 * and a path from the street edge to the front door.
 *
 * The path is the only part that could be accused of invention, so it is drawn
 * only when the model actually has a door facing the street — `entrance` is
 * `null` otherwise and no path is emitted. Its length is computed to the plot
 * boundary rather than to a fixed distance, so it always meets the edge.
 *
 * Heights are staggered on purpose. These are coplanar horizontals stacked
 * within a few centimetres of each other, and a paving box whose top face sat
 * exactly on the slab's top face would z-fight into a shimmering mess.
 */
function siteBoxes(project: Project, building: SceneGeometry['building'], entrance: SceneGeometry['entrance'], out: Box[]): void {
  const groundId = project.floors.find((fl) => fl.order === 0)?.id ?? project.floors[0]?.id ?? '';
  const verge = 6;

  // Lawn: the whole site plus a generous verge, so the plot edge is a change of
  // ground rather than a hard line ending in nothing.
  out.push({
    x: 0,
    y: -0.3,
    z: 0,
    w: project.plot.width + verge,
    h: 0.1,
    d: project.plot.depth + verge,
    ry: 0,
    color: LAWN_COLOR,
    roughness: 1,
    metalness: 0,
    opacity: 1,
    kind: 'lawn',
    surface: 'lawn',
    floorId: groundId,
  });

  // Apron: paving hard against the building, which is what stops the lawn
  // running right up the wall and looking like the house is sitting in a field.
  if (building.width > 0 && building.depth > 0) {
    const apron = 1.3;
    out.push({
      x: building.cx,
      y: -0.04,
      z: building.cz,
      w: building.width + apron * 2,
      h: 0.12,
      d: building.depth + apron * 2,
      ry: 0,
      color: PAVING_COLOR,
      roughness: 0.94,
      metalness: 0,
      opacity: 1,
      kind: 'paving',
      surface: 'paving',
      floorId: groundId,
    });
  }

  if (!entrance) return;
  const dir = STREET_DIR[project.plot.orientation] ?? STREET_DIR[0]!;
  const halfW = project.plot.width / 2;
  const halfD = project.plot.depth / 2;
  const toEdge =
    dir.x > 0 ? halfW - entrance.x : dir.x < 0 ? entrance.x + halfW : Number.POSITIVE_INFINITY;
  const toEdgeZ = dir.z > 0 ? halfD - entrance.z : dir.z < 0 ? entrance.z + halfD : Number.POSITIVE_INFINITY;
  const reach = Math.min(toEdge, toEdgeZ);
  if (!Number.isFinite(reach) || reach <= 0.5) return;

  // Overlap the threshold slightly so the path tucks under the door frame
  // rather than stopping a hair short of it.
  const length = reach + 0.4;
  const alongX = dir.x !== 0;
  const width = Math.max(1.3, entrance.width + 0.6);

  out.push({
    x: alongX ? entrance.x + dir.x * (length / 2 - 0.2) : entrance.x,
    y: 0.02,
    z: alongX ? entrance.z : entrance.z + dir.z * (length / 2 - 0.2),
    w: alongX ? length : width,
    h: 0.04,
    d: alongX ? width : length,
    ry: 0,
    color: PATH_COLOR,
    roughness: 0.92,
    metalness: 0,
    opacity: 1,
    kind: 'path',
    surface: 'paving',
    floorId: groundId,
  });
}

/**
 * Which way the street lies, in world coordinates.
 *
 * `Orientation` is a compass bearing from plan-north, and plan-north is −y, so
 * the bearing maps straight onto world axes with no rotation anywhere: north is
 * −Z, east is +X.
 */
export const STREET_DIR: Record<number, { x: number; z: number }> = {
  0: { x: 0, z: -1 },
  90: { x: 1, z: 0 },
  180: { x: 0, z: 1 },
  270: { x: -1, z: 0 },
};

/**
 * The front door: the ground-floor door in the exterior wall that faces the
 * street.
 *
 * Returns `null` rather than guessing when the model has no such door, because
 * a path drawn to an invented entrance would be a lie about the design — the
 * site simply gets no path.
 */
function findEntrance(project: Project, f: Frame): SceneGeometry['entrance'] {
  const dir = STREET_DIR[project.plot.orientation] ?? STREET_DIR[0]!;
  const ground = project.floors.find((fl) => fl.order === 0);
  if (!ground) return null;

  let best: { score: number; x: number; z: number; width: number } | null = null;
  for (const wall of project.walls) {
    if (wall.floorId !== ground.id || wall.type !== 'exterior') continue;
    const dx = wall.b.x - wall.a.x;
    const dy = wall.b.y - wall.a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    // A wall has two perpendiculars and only one of them is its outside, so the
    // test has to consider both. Taking a single perpendicular and asking which
    // way it points is not enough — which one that is depends on the order the
    // wall's endpoints were entered, and getting it wrong silently reported "no
    // entrance" for every door in the building.
    const px = -dy / len;
    const py = dx / len;
    const facing = Math.abs(px * dir.x + py * dir.z);
    if (facing <= 0.2) continue; // this wall does not front the street at all

    for (const o of wall.openings) {
      if (o.kind === 'window') continue;
      const s = Math.max(0, Math.min(len, o.offset));
      // Prefer a door squarely on the street wall; break ties on the one that
      // runs furthest along it, so the choice is stable rather than arbitrary.
      const score = facing * 100 + s / len;
      if (best && score <= best.score) continue;
      best = {
        score,
        x: f.tx(wall.a.x + (dx / len) * s),
        z: f.tz(wall.a.y + (dy / len) * s),
        width: o.width,
      };
    }
  }
  if (!best) return null;
  return { x: best.x, z: best.z, width: best.width };
}