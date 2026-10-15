/**
 * Drawing conventions for the 2D plan.
 *
 * These are the parts of "looks like a drawing" that are geometry rather than
 * styling: the poché of a cut wall, the swing of a door, the frame of a window,
 * the symbol that tells you a rectangle is a bath and not a cupboard.
 *
 * Everything here is pure and returns numbers. None of it touches the model —
 * `wall.thickness` stays exactly what the user set, and every clamp below is a
 * *rendering* clamp that stops a wall disappearing when you zoom out.
 */
import { TOL, wallFrame } from '../../model/geometry.ts';
import type { Wall } from '../../model/types.ts';

/**
 * A wall drawn as solid piers with the openings knocked out between them.
 *
 * Drawing the whole wall as one polygon and painting the openings back over it
 * looks fine at 100 % zoom and falls apart at 25 %: the lighter opening fill no
 * longer fully covers the wall beneath it, and every door gets a dark outline
 * like a sticker. Splitting the wall into the pieces between its openings is
 * how the SVG exporter already does it, and it is correct at every zoom.
 *
 * `halfM` defaults to the model thickness and is only overridden to hold a
 * pixel floor when zoomed out — see `drawnHalfThicknessPx`.
 */
export function wallPiers(wall: Wall, halfM: number = wall.thickness / 2): Array<Array<[number, number]>> {
  const f = wallFrame(wall);
  const h = halfM;
  if (f.length < TOL.dimension) return [];

  const quad = (from: number, to: number): Array<[number, number]> => {
    const p0 = at(wall, f, from, -h);
    const p1 = at(wall, f, to, -h);
    const p2 = at(wall, f, to, h);
    const p3 = at(wall, f, from, h);
    return [p0, p1, p2, p3];
  };

  const openings = [...wall.openings].sort((a, b) => a.offset - b.offset);
  if (!openings.length) return [quad(0, f.length)];

  const piers: Array<Array<[number, number]>> = [];
  let cursor = 0;
  for (const o of openings) {
    const start = clamp(o.offset - o.width / 2, 0, f.length);
    const end = clamp(o.offset + o.width / 2, 0, f.length);
    if (start - cursor > TOL.point) piers.push(quad(cursor, start));
    cursor = Math.max(cursor, end);
  }
  if (f.length - cursor > TOL.point) piers.push(quad(cursor, f.length));
  return piers;
}

function at(wall: Wall, f: ReturnType<typeof wallFrame>, along: number, side: number): [number, number] {
  return [
    wall.a.x + f.dir.x * along + f.normal.x * side,
    wall.a.y + f.dir.y * along + f.normal.y * side,
  ];
}

const clamp = (n: number, lo: number, hi: number): number => (n < lo ? lo : n > hi ? hi : n);

/** Line weight by wall class. Real drawings weight the cut by what is cut. */
export const WALL_FILL: Record<string, string> = {
  exterior: '#2b2722',
  interior: '#5f584c',
  parapet: '#8d8577',
  railing: '#a9a196',
  boundary: '#b9b2a3',
};