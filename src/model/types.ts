/**
 * The canonical Argon architectural model.
 *
 * ONE model is the source of truth for the 2D plan, the 3D building, every
 * measurement, every validation issue, the AI tool surface, and save/load.
 * Nothing in the app holds architectural state outside this shape.
 *
 * ── Coordinate system ────────────────────────────────────────────────────────
 *   Plan coordinates are METRES, X grows east/right, Y grows south/down.
 *   The origin is the plot's north-west corner.
 *
 *   Y grows downward on purpose: it makes the SVG floor plan a direct mapping
 *   with no flip, and image-trace calibration a plain 2×3 affine. The 3D scene
 *   maps plan (x, y) -> world (x - plotW/2, elevation, y - plotD/2), which puts
 *   the camera's -Z forward direction at plan-south and keeps the building
 *   centred on the world origin.
 *
 * ── Units ────────────────────────────────────────────────────────────────────
 *   Every number in this model is metres or square metres, always. Display
 *   units (m / ft / ft-in) are a pure view concern, applied at the UI edge only.
 */

// ────────────────────────────────────────────────────────────── primitives ────

/** Plan-space point in metres. */
export interface Vec2 {
  x: number;
  y: number;
}

/** Axis-aligned rectangle in metres. The room primitive. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  depth: number;
}

export type Id = string;

// ───────────────────────────────────────────────────────────────── plot ───────

/** Compass bearing of the plot's "front" street edge, in degrees clockwise from plan-north. */
export type Orientation = 0 | 90 | 180 | 270;

export interface Setbacks {
  front: number;
  rear: number;
  left: number;
  right: number;
}

export interface Plot {
  width: number;
  depth: number;
  /** Street edge. Doors facing this edge are treated as the entrance side. */
  orientation: Orientation;
  setbacks: Setbacks;
}

// ─────────────────────────────────────────────────────────────── brief ────────

export type RoomKind =
  | 'living'
  | 'dining'
  | 'kitchen'
  | 'bedroom'
  | 'bathroom'
  | 'utility'
  | 'office'
  | 'guest'
  | 'prayer'
  | 'storage'
  | 'corridor'
  | 'balcony'
  | 'terrace'
  | 'garage'
  | 'hall'
  | 'pantry'
  | 'lobby';

export type DesignStyle = 'modern' | 'contemporary' | 'traditional' | 'minimalist' | 'japandi';

/** Human answers from the guided onboarding. This is what the generator reads. */
export interface DesignBrief {
  plot: Plot;
  floorCount: number;
  rooms: Array<{
    kind: RoomKind;
    count: number;
    /** Optional target area in m². The generator scales to fit regardless. */
    targetArea?: number;
  }>;
  /** Preferred sizes keyed by room kind, in m². Empty means "use defaults". */
  preferredAreas: Partial<Record<RoomKind, number>>;
  style: DesignStyle;
  budgetUsd?: number;
  preferences: {
    accessibility: boolean;
    ventilation: boolean;
    privacy: boolean;
    daylight: boolean;
  };
  notes?: string;
}

// ─────────────────────────────────────────────────────────────── floors ───────

export interface Floor {
  id: Id;
  name: string;
  /** Finished floor level above the plot datum, in metres. */
  elevation: number;
  /** Floor-to-floor height in metres. */
  height: number;
  order: number;
  roomIds: Id[];
  wallIds: Id[];
  stairIds: Id[];
  outdoorIds: Id[];
}

// ──────────────────────────────────────────────────────────────── walls ───────

export type WallType = 'exterior' | 'interior' | 'parapet' | 'boundary' | 'railing';

/**
 * A wall segment. Openings are NESTED so that an opening can never reference a
 * wall that does not exist, and so a wall edit carries its doors and windows
 * with it automatically.
 */
export interface Wall {
  id: Id;
  floorId: Id;
  type: WallType;
  /** Wall centreline start point. */
  a: Vec2;
  /** Wall centreline end point. */
  b: Vec2;
  /** Total thickness in metres, centred on the centreline. */
  thickness: number;
  /** Height in metres. Defaults to the floor height. */
  height: number;
  /** Rooms this wall bounds. Recomputed by the planner, never hand-edited. */
  roomIds: Id[];
  openings: Opening[];
  /** Material role key, e.g. "exterior.render" */
  material?: string;
}

export type OpeningKind = 'door' | 'window' | 'doorway' | 'opening';

export interface Opening {
  id: Id;
  kind: OpeningKind;
  /** Distance along the wall centreline from point `a`, in metres. */
  offset: number;
  /** Clear opening width in metres. */
  width: number;
  /** Sill height for windows, 0 for doors. */
  sill: number;
  height: number;
  /** Door leaf swing: which side of the wall the door opens into. */
  swing?: 'positive' | 'negative';
  /** Hinge side along the wall. */
  hinge?: 'start' | 'end';
  /** For doors: connect this room to the room on the other side. */
  connects?: [Id | null, Id | null];
  material?: string;
}

// ──────────────────────────────────────────────────────────────── rooms ───────

export interface Room {
  id: Id;
  floorId: Id;
  kind: RoomKind;
  label: string;
  /** Floor-plan rectangle in metres. */
  x: number;
  y: number;
  width: number;
  depth: number;
  /** Ceiling height; defaults to the floor height. */
  height: number;
  /** True for balcony/terrace: excluded from gross covered area. */
  outdoor?: boolean;
  material?: string;
  floorMaterial?: string;
  /** Assigned by the generator / validation to mark the way in from outside. */
  isEntrance?: boolean;
}

// ─────────────────────────────────────────────────────────────── stairs ───────

export interface Staircase {
  id: Id;
  floorId: Id;
  name: string;
  /** Footprint centre in plan coordinates. */
  x: number;
  y: number;
  width: number;
  /** Total run in metres along +Y (down) from the top landing. */
  run: number;
  riserCount: number;
  /** Storey height the flight climbs, in metres. Derived from the floors. */
  rise?: number;
  /** -1 descends from this floor, +1 ascends to it. */
  direction: -1 | 1;
  /** The floor this stair arrives at / departs from. */
  connectsToFloorId: Id | null;
  /** Rectangular void cut in the floor above so the stair is walkable. */
  voidWidth?: number;
  voidDepth?: number;
  /** Which end of the run is the top landing. */
  topAtStart?: boolean;
}

// ─────────────────────────────────────────────────────────────── outdoor ──────

export type OutdoorKind = 'balcony' | 'terrace' | 'porch';

export interface OutdoorSpace {
  id: Id;
  floorId: Id;
  kind: OutdoorKind;
  label: string;
  x: number;
  y: number;
  width: number;
  depth: number;
  /** Which elevation this deck sits at (balconies are above ground). */
  elevationOffset: number;
  /** Guard height in metres. */
  railingHeight: number;
  /** Room this outdoor space is served from, for access validation. */
  servesRoomId?: Id;
}

// ────────────────────────────────────────────────────────────── furniture ──────

export interface FurnitureItem {
  id: Id;
  floorId: Id;
  roomId: Id | null;
  catalogId: string;
  label: string;
  /** Centre position in plan coordinates. */
  x: number;
  y: number;
  /** Footprint in metres, unrotated. */
  width: number;
  depth: number;
  height: number;
  /** Rotation about the vertical axis, degrees clockwise. */
  rotation: number;
  color?: string;
}

// ────────────────────────────────────────────────────────────── materials ─────

export interface MaterialDef {
  id: string;
  label: string;
  color: string;
  roughness: number;
  metalness: number;
  opacity?: number;
  /** Used by the SVG exporter as a hex fill. */
  kind: 'concrete' | 'plaster' | 'wood' | 'tile' | 'glass' | 'metal' | 'paint' | 'stone';
}

// ──────────────────────────────────────────────────────────── constraints ─────

export type Severity = 'error' | 'warning' | 'info';

export type IssueCode =
  // geometry
  | 'room_out_of_plot'
  | 'room_overlap'
  | 'room_degenerate'
  | 'room_inside_wall'
  | 'wall_out_of_plot'
  | 'wall_zero_length'
  | 'wall_not_shared'
  | 'wall_unbounded'
  // openings
  | 'opening_overflows_wall'
  | 'opening_out_of_bounds'
  | 'opening_overlap'
  | 'door_no_access'
  | 'door_swing_blocked'
  | 'window_into_service_space'
  // circulation & floors
  | 'room_no_access'
  | 'stair_not_connected'
  | 'stair_geometry_invalid'
  | 'floor_disconnected'
  // furniture
  | 'furniture_crosses_wall'
  | 'furniture_overlap'
  | 'furniture_out_of_room'
  // plot & compliance
  | 'setback_violation'
  | 'coverage_exceeded'
  | 'far_exceeded'
  | 'no_entrance'
  // brief satisfaction
  | 'brief_room_missing'
  | 'dimension_implausible';

export interface Issue {
  id: Id;
  code: IssueCode;
  severity: Severity;
  /** Human sentence naming the object, the problem, and what would fix it. */
  message: string;
  /** Element IDs this issue is about, for click-to-focus. */
  elements: Id[];
  /** Concrete, deterministic corrections the user (or the agent) can apply. */
  fixes?: SuggestedFix[];
}

export interface SuggestedFix {
  label: string;
  /**
   * The name of a registered tool. Typed as `ToolName` so the compiler rejects
   * a correction naming a tool that does not exist — a fix the app cannot
   * execute is worse than no fix at all, because clicking it appears to work.
   */
  tool: import('../tools/registry.ts').ToolName;
  input: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────── measurements ──────

export interface RoomMeasurement {
  roomId: Id;
  label: string;
  kind: RoomKind;
  area: number;
  perimeter: number;
  width: number;
  depth: number;
}

export interface BuildingMeasurements {
  plotArea: number;
  buildableArea: number;
  /** Sum of all indoor room areas on all floors. */
  netIndoorArea: number;
  /** Total built footprint on the ground floor (indoor + covered outdoor decks). */
  footprintArea: number;
  /** Sum of all indoor areas across every floor — the numerator of FAR. */
  grossCoveredArea: number;
  openSiteArea: number;
  /** footprint / plot. */
  plotCoverage: number;
  /** grossCoveredArea / plot. */
  floorAreaRatio: number;
  perFloor: Array<{
    floorId: Id;
    label: string;
    elevation: number;
    netArea: number;
    coveredArea: number;
    roomCount: number;
  }>;
  rooms: RoomMeasurement[];
}

// ────────────────────────────────────────────────────────── underlay ─────────

/**
 * An imported floor-plan image used as a tracing underlay.
 * `dataUrl` is a data: URL (never a remote fetch, so nothing leaks off-device).
 */
export interface Underlay {
  id: Id;
  name: string;
  dataUrl: string;
  naturalWidth: number;
  naturalHeight: number;
  /** Placement of the image in plan coordinates (bounding box, in metres). */
  x: number;
  y: number;
  width: number;
  depth: number;
  opacity: number;
  rotation: number;
  /**
   * Image pixel -> world calibration. Established from at least one user-known
   * real-world dimension. `scale` is metres-per-pixel; `offX/offY` place the
   * image's top-left pixel in plan coordinates.
   */
  calibration: Calibration | null;
}

export interface Calibration {
  /** Metres per image pixel. */
  scale: number;
  /** Plan coordinate of image pixel (0,0). */
  offX: number;
  offY: number;
  /** What the user measured to derive this, kept for the inspector. */
  source: {
    pixelDistance: number;
    realDistance: number;
    label: string;
  };
  /** True once at least one known dimension has been supplied. */
  confirmed: boolean;
  /**
   * How far the second calibration point lands from where the user put it, in
   * metres. Only two-point calibration can produce a non-zero value, and only
   * when the run measured in the image is not parallel to the run it was placed
   * on in the plan — a uniform scale cannot satisfy both points at once. Left
   * undefined rather than 0 by one-point calibration, which has no second point
   * to be wrong about. The inspector shows this so a skewed scan cannot silently
   * slide the drawing across the plot.
   */
  residual?: number;
}

// ────────────────────────────────────────────────────────────── history ───────

export interface HistoryEntry {
  id: Id;
  at: number;
  /** Who made the change. */
  actor: 'user' | 'assistant' | 'system';
  label: string;
  /** Tool name(s) that produced it. */
  ops: string[];
  /** Ids created, so a single change can be undone as a unit. */
  createdIds: Id[];
  removedIds: Id[];
  /** Set when the entry awaits user approval. */
  approval?: 'pending' | 'approved' | 'rejected';
}

// ───────────────────────────────────────────────────────────────── project ────

export interface Project {
  schemaVersion: number;
  id: Id;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** Display units. Geometry is always metres. */
  displayUnits: 'm' | 'ft';
  brief: DesignBrief | null;
  plot: Plot;
  floors: Floor[];
  rooms: Room[];
  walls: Wall[];
  stairs: Staircase[];
  outdoor: OutdoorSpace[];
  furniture: FurnitureItem[];
  materials: Record<string, MaterialDef>;
  underlays: Underlay[];
  /** Stable, monotonically increasing — used by the AI to cache read-only analysis. */
  revision: number;
}

export const SCHEMA_VERSION = 1;

// ──────────────────────────────────────────────────────────── selection ───────

export type ElementKind = 'room' | 'wall' | 'opening' | 'stair' | 'outdoor' | 'furniture' | 'floor' | 'underlay';

export interface Selection {
  kinds: ElementKind[];
  ids: Id[];
}