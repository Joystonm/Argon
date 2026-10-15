/**
 * Default materials and the furniture catalogue.
 *
 * All dimensions are real-world metres for domestic construction, and are the
 * same numbers the constraint engine checks against. Nothing here is decorative
 * filler: if an item exists in the catalogue, `validate.ts` can measure it.
 */
import type { MaterialDef, RoomKind } from './types.ts';
import { round } from './geometry.ts';

export const DEFAULT_MATERIALS: Record<string, MaterialDef> = {
  'exterior.render': {
    id: 'exterior.render',
    label: 'Off-white render',
    color: '#e8e3db',
    roughness: 0.92,
    metalness: 0,
    kind: 'plaster',
  },
  'exterior.brick': {
    id: 'exterior.brick',
    label: 'Warm brick',
    color: '#a3705a',
    roughness: 0.95,
    metalness: 0,
    kind: 'stone',
  },
  'exterior.concrete': {
    id: 'exterior.concrete',
    label: 'Board-formed concrete',
    color: '#b3aea6',
    roughness: 0.88,
    metalness: 0,
    kind: 'concrete',
  },
  'exterior.timber': {
    id: 'exterior.timber',
    label: 'Cedar cladding',
    color: '#9a6a44',
    roughness: 0.78,
    metalness: 0,
    kind: 'wood',
  },
  'interior.plaster': {
    id: 'interior.plaster',
    label: 'White plaster',
    color: '#f4f2ee',
    roughness: 0.95,
    metalness: 0,
    kind: 'plaster',
  },
  'interior.partition': {
    id: 'interior.partition',
    label: 'Partition board',
    color: '#eceae6',
    roughness: 0.9,
    metalness: 0,
    kind: 'plaster',
  },
  'glass.clear': {
    id: 'glass.clear',
    label: 'Clear glazing',
    color: '#cfe0e6',
    roughness: 0.05,
    metalness: 0,
    opacity: 0.28,
    kind: 'glass',
  },
  'door.timber': {
    id: 'door.timber',
    label: 'Timber door',
    color: '#8a6a4b',
    roughness: 0.7,
    metalness: 0,
    kind: 'wood',
  },
  'frame.dark': {
    id: 'frame.dark',
    label: 'Dark aluminium frame',
    color: '#3a3a38',
    roughness: 0.35,
    metalness: 0.85,
    kind: 'metal',
  },
  'floor.oak': {
    id: 'floor.oak',
    label: 'Oak flooring',
    color: '#c39a6b',
    roughness: 0.55,
    metalness: 0,
    kind: 'wood',
  },
  'floor.tile': {
    id: 'floor.tile',
    label: 'Porcelain tile',
    color: '#d8d5cf',
    roughness: 0.35,
    metalness: 0,
    kind: 'tile',
  },
  'floor.stone': {
    id: 'floor.stone',
    label: 'Limestone',
    color: '#cbc4b8',
    roughness: 0.6,
    metalness: 0,
    kind: 'stone',
  },
  'floor.concrete': {
    id: 'floor.concrete',
    label: 'Polished concrete',
    color: '#a9a49c',
    roughness: 0.42,
    metalness: 0,
    kind: 'concrete',
  },
  'floor.carpet': {
    id: 'floor.carpet',
    label: 'Wool carpet',
    color: '#b9b0a4',
    roughness: 0.98,
    metalness: 0,
    kind: 'plaster',
  },
  'ground.site': {
    id: 'ground.site',
    label: 'Site',
    color: '#dfdcd3',
    roughness: 1,
    metalness: 0,
    kind: 'plaster',
  },
  'roof.deck': {
    id: 'roof.deck',
    label: 'Roof screed',
    color: '#8f8a82',
    roughness: 0.9,
    metalness: 0,
    kind: 'concrete',
  },
  'accent.wood': {
    id: 'accent.wood',
    label: 'Walnut accent',
    color: '#6f4a2f',
    roughness: 0.5,
    metalness: 0,
    kind: 'wood',
  },
};

/**
 * Material roles, read off the id prefix.
 *
 * The catalogue names materials `floor.*`, `wall.*`, `accent.*`, and the
 * `kind` field describes the surface finish (concrete, plaster, wood…) rather
 * than where the material goes. Picking a floor finish from a dropdown should
 * not offer "Reinforced concrete", so the two questions are kept separate.
 */
export const isFloorMaterial = (m: { id: string }): boolean => m.id.startsWith('floor.');
export const isWallMaterial = (m: { id: string }): boolean => m.id.startsWith('wall.') || m.id.startsWith('accent.');
export const materialRole = (m: { id: string }): 'floor' | 'wall' | 'accent' =>
  m.id.startsWith('floor.') ? 'floor' : m.id.startsWith('accent.') ? 'accent' : 'wall';

/** Floor material per room kind, used by the generator and the 3D builder. */
export const FLOOR_MATERIAL_BY_KIND: Record<RoomKind, string> = {
  living: 'floor.oak',
  dining: 'floor.oak',
  bedroom: 'floor.carpet',
  bathroom: 'floor.tile',
  kitchen: 'floor.tile',
  utility: 'floor.tile',
  office: 'floor.oak',
  guest: 'floor.carpet',
  prayer: 'floor.carpet',
  storage: 'floor.concrete',
  corridor: 'floor.stone',
  hall: 'floor.stone',
  lobby: 'floor.stone',
  pantry: 'floor.tile',
  balcony: 'floor.concrete',
  terrace: 'floor.stone',
  garage: 'floor.concrete',
};

// ─────────────────────────────────────────────────────────── catalogue ────────

export interface CatalogItem {
  id: string;
  label: string;
  /** Footprint, metres. */
  width: number;
  depth: number;
  height: number;
  /** Which room kinds it makes sense in — used by the inspector's picker. */
  roomKinds: RoomKind[];
  category: 'seating' | 'sleeping' | 'storage' | 'table' | 'kitchen' | 'bath' | 'appliance' | 'decor';
  color?: string;
  /** How the 3D builder should draw it. */
  shape: 'box' | 'cylinder' | 'lshape' | 'round' | 'panel';
}

const item = (
  id: string,
  label: string,
  width: number,
  depth: number,
  height: number,
  category: CatalogItem['category'],
  shape: CatalogItem['shape'],
  roomKinds: RoomKind[],
  color?: string,
): CatalogItem => ({ id, label, width, depth, height, category, shape, roomKinds, color });

export const CATALOG: CatalogItem[] = [
  // seating
  item('sofa-3', '3-seat sofa', 2.1, 0.9, 0.82, 'seating', 'box', ['living'], '#8a7f72'),
  item('sofa-l', 'L-shaped sofa', 2.6, 1.7, 0.82, 'seating', 'lshape', ['living'], '#8a7f72'),
  item('sofa-2', '2-seat sofa', 1.6, 0.9, 0.82, 'seating', 'box', ['living', 'guest'], '#8a7f72'),
  item('armchair', 'Armchair', 0.85, 0.85, 0.9, 'seating', 'box', ['living', 'office'], '#968b7d'),
  item('coffee-table', 'Coffee table', 1.1, 0.6, 0.42, 'table', 'box', ['living'], '#6f5a44'),
  item('dining-chair', 'Dining chair', 0.45, 0.45, 0.9, 'seating', 'box', ['dining', 'kitchen'], '#7a6a58'),
  // sleeping
  item('bed-double', 'Double bed', 1.5, 2.0, 0.6, 'sleeping', 'box', ['bedroom'], '#d9d4cb'),
  item('bed-queen', 'Queen bed', 1.6, 2.05, 0.6, 'sleeping', 'box', ['bedroom'], '#d9d4cb'),
  item('bed-single', 'Single bed', 0.95, 2.0, 0.6, 'sleeping', 'box', ['bedroom', 'guest'], '#d9d4cb'),
  item('nightstand', 'Nightstand', 0.45, 0.4, 0.55, 'storage', 'box', ['bedroom'], '#8a6a4b'),
  item('wardrobe', 'Wardrobe', 1.8, 0.6, 2.2, 'storage', 'box', ['bedroom'], '#9a8272'),
  // tables
  item('dining-table', 'Dining table', 1.8, 0.9, 0.75, 'table', 'box', ['dining'], '#7a5c3e'),
  item('desk', 'Desk', 1.4, 0.7, 0.75, 'table', 'box', ['office', 'bedroom'], '#c7c2b8'),
  item('side-table', 'Side table', 0.45, 0.45, 0.55, 'table', 'box', ['living', 'bedroom'], '#6f5a44'),
  // kitchen
  item('kitchen-run', 'Kitchen counter run', 3.0, 0.65, 0.92, 'kitchen', 'box', ['kitchen'], '#cfccc6'),
  item('kitchen-island', 'Kitchen island', 2.2, 1.0, 0.92, 'kitchen', 'box', ['kitchen'], '#c4c1bb'),
  item('fridge', 'Refrigerator', 0.75, 0.7, 1.85, 'appliance', 'box', ['kitchen'], '#c9c6c0'),
  item('stove', 'Cooktop', 0.6, 0.55, 0.92, 'appliance', 'box', ['kitchen'], '#9a9790'),
  item('sink', 'Kitchen sink', 0.8, 0.5, 0.92, 'kitchen', 'box', ['kitchen'], '#b6b3ac'),
  item('upper-cabinet', 'Wall cabinet', 1.8, 0.35, 0.7, 'storage', 'panel', ['kitchen'], '#d5d2cc'),
  // bath
  item('bathtub', 'Bathtub', 1.7, 0.75, 0.6, 'bath', 'box', ['bathroom'], '#f2f0ec'),
  item('bathtub-compact', 'Compact bath', 1.5, 0.72, 0.58, 'bath', 'box', ['bathroom'], '#f2f0ec'),
  item('shower-corner', 'Corner shower', 0.9, 0.9, 2.05, 'bath', 'box', ['bathroom'], '#dfe6e8'),
  item('basin', 'Wash basin', 0.6, 0.45, 0.85, 'bath', 'box', ['bathroom'], '#f0eeea'),
  item('wc', 'Toilet', 0.4, 0.7, 0.8, 'bath', 'box', ['bathroom'], '#f2f0ec'),
  // appliances / utility
  item('washing-machine', 'Washing machine', 0.6, 0.62, 0.85, 'appliance', 'box', ['utility', 'bathroom'], '#dcd9d3'),
  item('dryer', 'Dryer', 0.6, 0.62, 0.85, 'appliance', 'box', ['utility'], '#dcd9d3'),
  item('water-heater', 'Water heater', 0.5, 0.5, 1.4, 'appliance', 'cylinder', ['utility'], '#cfccc6'),
  item('shelving', 'Shelving unit', 1.2, 0.4, 1.9, 'storage', 'panel', ['storage', 'utility', 'garage'], '#b5b0a6'),
  // decor
  item('plant-large', 'Large plant', 0.6, 0.6, 1.5, 'decor', 'cylinder', ['living', 'balcony', 'terrace'], '#5f7d55'),
  item('rug', 'Rug', 2.4, 1.7, 0.02, 'decor', 'box', ['living', 'bedroom'], '#c9bda9'),
  item('tv-unit', 'TV unit', 1.8, 0.4, 0.5, 'storage', 'box', ['living'], '#6d675e'),
];

export const catalogById = new Map(CATALOG.map((c) => [c.id, c]));

export function catalogFor(kinds: RoomKind[]): CatalogItem[] {
  return CATALOG.filter((c) => c.roomKinds.some((k) => kinds.includes(k)));
}

// ──────────────────────────────────────────────────────────── defaults ───────

/** Default clear sizes for openings, in metres. */
export const OPENING_DEFAULTS = {
  interiorDoor: { width: 0.9, height: 2.1, sill: 0 },
  bathroomDoor: { width: 0.8, height: 2.1, sill: 0 },
  entranceDoor: { width: 1.1, height: 2.4, sill: 0 },
  window: { width: 1.2, height: 1.4, sill: 0.9 },
  windowWide: { width: 2.4, height: 1.6, sill: 0.9 },
  terraceDoor: { width: 1.8, height: 2.4, sill: 0 },
} as const;

/** Default wall thicknesses, in metres. */
export const WALL_THICKNESS = {
  exterior: 0.23,
  interior: 0.1,
  parapet: 0.15,
  boundary: 0.15,
  railing: 0.1,
} as const;

/** Realistic target areas (m²) used when the brief does not specify a size. */
export const DEFAULT_ROOM_AREA: Record<RoomKind, number> = {
  living: 22,
  dining: 12,
  kitchen: 11,
  bedroom: 14,
  bathroom: 5,
  utility: 4,
  office: 8,
  guest: 10,
  prayer: 6,
  storage: 3,
  corridor: 0, // sized by the generator as the leftover circulation allowance
  balcony: 5,
  terrace: 12,
  garage: 16,
  hall: 6,
  lobby: 5,
  pantry: 3,
};

/** Rooms that should stay together in one zone (private wing). */
export const PRIVATE_KINDS: RoomKind[] = ['bedroom', 'bathroom', 'guest', 'prayer', 'storage'];
export const PUBLIC_KINDS: RoomKind[] = ['living', 'dining', 'kitchen', 'lobby', 'hall', 'office'];
export const SERVICE_KINDS: RoomKind[] = ['utility', 'pantry', 'storage', 'garage'];

/**
 * The room types offered in the toolbar palette.
 *
 * Eight of the seventeen `RoomKind`s. This is a palette, not the model: every
 * kind is still reachable from the inspector's Type dropdown, from the brief
 * wizard, and from the assistant's `create_room` tool. What the palette buys is
 * that you can *draw* the common rooms rather than drawing a bedroom and then
 * relabelling it.
 */
export const PALETTE_KINDS: RoomKind[] = [
  'living', 'kitchen', 'dining', 'bedroom', 'bathroom', 'hall', 'office', 'utility',
];

/**
 * A sensible starting rectangle for a hand-drawn room of this kind.
 *
 * Derived from the same target-area table the brief generator uses, so a
 * Kitchen arrives roughly kitchen-sized rather than as a fixed 3 × 3 box. Pure
 * and testable — the canvas only converts metres to pixels.
 */
export function defaultRoomFootprint(kind: RoomKind): { width: number; depth: number } {
  // The generator sizes the corridor itself as the leftover circulation
  // allowance, so there is no target area to work from; give it the shape a
  // corridor actually has.
  if (kind === 'corridor') return { width: 1.2, depth: 3.6 };

  const area = DEFAULT_ROOM_AREA[kind] || 12;
  // Bigger rooms want to be wide and shallow, small rooms closer to square.
  const ratio = area >= 18 ? 1.5 : area <= 6 ? 1.15 : 1.3;
  const depth = Math.min(Math.max(Math.sqrt(area / ratio), 2.2), 7);
  const width = Math.min(Math.max(area / depth, 2.2), 9);
  return { width: round(width, 2), depth: round(depth, 2) };
}

export const KIND_LABEL: Record<RoomKind, string> = {
  living: 'Living room',
  dining: 'Dining',
  kitchen: 'Kitchen',
  bedroom: 'Bedroom',
  bathroom: 'Bathroom',
  utility: 'Utility',
  office: 'Home office',
  guest: 'Guest room',
  prayer: 'Prayer room',
  storage: 'Storage',
  corridor: 'Corridor',
  balcony: 'Balcony',
  terrace: 'Terrace',
  garage: 'Garage',
  hall: 'Hall',
  lobby: 'Entrance lobby',
  pantry: 'Pantry',
};