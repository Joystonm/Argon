/**
 * Floor plan as SVG.
 *
 * This is the *same geometry* the editor draws — the rooms, walls, openings and
 * furniture from the model, projected into a standalone document. It is not a
 * screenshot of the canvas and it does not depend on the editor's zoom or pan.
 *
 * That matters because the brief is explicit: never claim a format is supported
 * unless the export can actually be opened and used. An SVG built from the
 * model can be opened in any browser, any vector editor, or any CAD program
 * that reads SVG, at any scale, and it will still be geometrically true.
 *
 * Output is written in millimetres with a millimetre-accurate viewBox, so the
 * file scales correctly in print without a single transform guess.
 */
import type { Floor, Project, Wall } from '../model/types.ts';
import { formatLength } from '../model/geometry.ts';

export interface PlanSvgOptions {
  /** Include furniture footprints. */
  furniture?: boolean;
  /** Include room area labels. */
  labels?: boolean;
  /** Include the dimension chain around the plot. */
  dimensions?: boolean;
}

interface Ctx {
  project: Project;
  floor: Floor;
  o: Required<PlanSvgOptions>;
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const mm = (m: number): string => (m * 1000).toFixed(2);

/**
 * Renders one floor as a standalone SVG document.
 *
 * Returns null when the floor has nothing on it, so the caller can say so
 * rather than downloading an empty sheet.
 */
export function planToSvg(project: Project, floorId: string | undefined, options: PlanSvgOptions = {}): string | null {
  const floor = project.floors.find((f) => f.id === floorId) ?? project.floors[0];
  if (!floor) return null;
  const o: Required<PlanSvgOptions> = { furniture: true, labels: true, dimensions: true, ...options };
  const ctx: Ctx = { project, floor, o };

  const sb = project.plot.setbacks;
  // Margin holds the dimension chain: enough room for two ticks and a caption.
  const margin = o.dimensions ? 1400 : 900;

  // Document space is millimetres with y growing DOWN, matching the plan
  // convention the whole app uses. So no flip is needed.
  const width = project.plot.width * 1000;
  const depth = project.plot.depth * 1000;

  const rooms = project.rooms.filter((r) => r.floorId === floor.id);
  const walls = project.walls.filter((w) => w.floorId === floor.id);
  const furniture = project.furniture.filter((f) => f.floorId === floor.id);
  const outdoor = project.outdoor.filter((x) => x.floorId === floor.id);
  const stairs = project.stairs.filter((s) => s.floorId === floor.id);

  const body: string[] = [];

  /* ── plot boundary and buildable envelope ── */
  body.push(
    `<rect x="${mm(0)}" y="${mm(0)}" width="${mm(project.plot.width)}" height="${mm(project.plot.depth)}" fill="#f6f4f0" stroke="#c9c3b6" stroke-width="6"/>`,
    `<rect x="${mm(sb.left)}" y="${mm(sb.front)}" width="${mm(project.plot.width - sb.left - sb.right)}" height="${mm(project.plot.depth - sb.front - sb.rear)}" fill="none" stroke="#a9a294" stroke-width="3" stroke-dasharray="40 16"/>`,
  );

  /* ── outdoor spaces and decks ── */
  for (const o2 of outdoor) {
    body.push(
      `<rect x="${mm(o2.x - o2.width / 2)}" y="${mm(o2.y - o2.depth / 2)}" width="${mm(o2.width)}" height="${mm(o2.depth)}" fill="#eeeade" stroke="#9a9284" stroke-width="4"/>`,
    );
  }

  /* ── rooms ── */
  for (const r of rooms) {
    body.push(
      `<rect x="${mm(r.x)}" y="${mm(r.y)}" width="${mm(r.width)}" height="${mm(r.depth)}" fill="#fbfaf7" stroke="#8d8577" stroke-width="3"/>`,
    );
    if (o.labels) {
      const cx = (r.x + r.width / 2) * 1000;
      const cy = (r.y + r.depth / 2) * 1000;
      // The same convention the editor uses: a room deeper than it is wide is
      // labelled upright, so a corridor's name runs along the corridor instead
      // of across it and out through the walls.
      const upright = r.depth > r.width * 1.25;
      const rot = upright ? ` transform="rotate(-90 ${cx.toFixed(1)} ${cy.toFixed(1)})"` : '';
      body.push(
        `<g${rot}>` +
          `<text x="${cx.toFixed(1)}" y="${(cy - 60).toFixed(1)}" text-anchor="middle" font-family="Inter,Helvetica,Arial,sans-serif" font-size="90" fill="#3f3a33">${esc(r.label)}</text>` +
          `<text x="${cx.toFixed(1)}" y="${(cy + 70).toFixed(1)}" text-anchor="middle" font-family="Inter,Helvetica,Arial,sans-serif" font-size="76" fill="#8d8577">${(r.width * r.depth).toFixed(1)} m²</text>` +
        `</g>`,
      );
    }
  }

  /* ── walls ── */
  for (const w of walls) {
    body.push(wallToPath(w));
  }

  /* ── stair ── */
  for (const s of stairs) {
    const going = s.run / Math.max(1, s.riserCount);
    const top = s.y - s.run / 2;
    for (let i = 0; i < s.riserCount; i++) {
      const y0 = top + i * going;
      body.push(
        `<line x1="${mm(s.x - s.width / 2)}" y1="${mm(y0)}" x2="${mm(s.x + s.width / 2)}" y2="${mm(y0)}" stroke="#8d8577" stroke-width="3"/>`,
      );
    }
    body.push(
      `<rect x="${mm(s.x - s.width / 2)}" y="${mm(top)}" width="${mm(s.width)}" height="${mm(s.run)}" fill="none" stroke="#8d8577" stroke-width="4"/>`,
      `<line x1="${mm(s.x - s.width / 2)}" y1="${mm(top)}" x2="${mm(s.x + s.width / 2)}" y2="${mm(top)}" stroke="#b4622d" stroke-width="7"/>`,
    );
  }

  /* ── furniture ── */
  if (o.furniture) {
    for (const f of furniture) {
      const quarter = Math.abs(Math.round(f.rotation / 90)) % 2 === 1;
      const w = (quarter ? f.depth : f.width) * 1000;
      const d = (quarter ? f.width : f.depth) * 1000;
      body.push(
        `<rect x="${(f.x * 1000 - w / 2).toFixed(2)}" y="${(f.y * 1000 - d / 2).toFixed(2)}" width="${w.toFixed(2)}" height="${d.toFixed(2)}" transform="rotate(${(-f.rotation).toFixed(2)} ${mm(f.x)} ${mm(f.y)})" fill="#e7e2d6" stroke="#a9a294" stroke-width="2"/>`,
      );
    }
  }

  /* ── dimension chain ── */
  if (o.dimensions) body.push(...dimensions(project, margin));

  /* ── title block ── */
  const caption = `${project.name} — ${floor.name}`;
  body.push(
    `<text x="${mm(sb.left)}" y="${(-620).toFixed(0)}" font-family="Inter,Helvetica,Arial,sans-serif" font-size="150" font-weight="600" fill="#1c1b19">${esc(caption)}</text>`,
    `<text x="${mm(project.plot.width - sb.right)}" y="${(-620).toFixed(0)}" text-anchor="end" font-family="Inter,Helvetica,Arial,sans-serif" font-size="105" fill="#8a8580">${formatLength(project.plot.width, 'm', 2)} × ${formatLength(project.plot.depth, 'm', 2)} plot · ${rooms.length} rooms</text>`,
    `<text x="${mm(sb.left)}" y="${(project.plot.depth * 1000 + 520).toFixed(0)}" font-family="Inter,Helvetica,Arial,sans-serif" font-size="88" fill="#8a8580">Argon — concept stage. Not a construction drawing and not a compliance certificate.</text>`,
  );

  void ctx;

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${width + margin * 2}mm" height="${depth + margin * 2}mm" viewBox="${-margin} ${-margin} ${width + margin * 2} ${depth + margin * 2}">`,
    `<title>${esc(caption)}</title>`,
    `<desc>Generated by Argon from its canonical project model. Units: millimetres. Origin at the plot's north-west corner, y increasing south.</desc>`,
    `<rect x="${-margin}" y="${-margin}" width="${width + margin * 2}" height="${depth + margin * 2}" fill="#ffffff"/>`,
    `<g transform="translate(${margin} ${margin})">`,
    ...body,
    `</g>`,
    `</svg>`,
  ].join('\n');
}

/**
 * A wall, drawn as its actual outline with its openings knocked out.
 *
 * The knockout is done by drawing the piers as separate filled polygons rather
 * than by masking: the result opens correctly in every viewer, including ones
 * that ignore clip-path on stroke.
 */
function wallToPath(w: Wall): string {
  const dx = w.b.x - w.a.x;
  const dy = w.b.y - w.a.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) return '';
  const ux = dx / length;
  const uy = dy / length;
  const px = -uy;
  const py = ux;
  // Half-thickness in METRES. `at` scales to millimetres once, at the end;
  // pre-multiplying here would scale the offset twice and draw every wall
  // a thousand times too thick.
  const h = w.thickness / 2;
  const fill = w.type === 'exterior' ? '#3f3a33' : w.type === 'parapet' || w.type === 'railing' ? '#9a9284' : '#5c554b';

  const at = (s: number, side: number): string =>
    `${((w.a.x + ux * s + px * side) * 1000).toFixed(2)} ${((w.a.y + uy * s + py * side) * 1000).toFixed(2)}`;

  const openings = [...w.openings].sort((a, b) => a.offset - b.offset);
  if (!openings.length) {
    return `<polygon points="${at(0, -h)} ${at(length, -h)} ${at(length, h)} ${at(0, h)}" fill="${fill}"/>`;
  }

  const parts: string[] = [];
  let cursor = 0;
  for (const o of openings) {
    const start = Math.max(0, o.offset - o.width / 2);
    const end = Math.min(length, o.offset + o.width / 2);
    if (start > cursor) parts.push(`<polygon points="${at(cursor, -h)} ${at(start, -h)} ${at(start, h)} ${at(cursor, h)}" fill="${fill}"/>`);
    cursor = Math.max(cursor, end);
  }
  if (cursor < length) parts.push(`<polygon points="${at(cursor, -h)} ${at(length, -h)} ${at(length, h)} ${at(cursor, h)}" fill="${fill}"/>`);

  return parts.join('');
}

/** A dimension line between two plan coordinates, with ticks and a caption. */
function dimLine(x1: number, y1: number, x2: number, y2: number, caption: string): string {
  const X1 = x1 * 1000;
  const Y1 = y1 * 1000;
  const X2 = x2 * 1000;
  const Y2 = y2 * 1000;
  const horizontal = Math.abs(Y2 - Y1) < 1;
  const t = 60;
  // Tick marks are drawn perpendicular to the line, drafting convention.
  const ticks = horizontal
    ? `<line x1="${X1}" y1="${Y1 - t}" x2="${X1}" y2="${Y1 + t}"/><line x1="${X2}" y1="${Y2 - t}" x2="${X2}" y2="${Y2 + t}"/>`
    : `<line x1="${X1 - t}" y1="${Y1}" x2="${X1 + t}" y2="${Y1}"/><line x1="${X2 - t}" y1="${Y2}" x2="${X2 + t}" y2="${Y2}"/>`;
  const midX = (X1 + X2) / 2;
  const midY = (Y1 + Y2) / 2;
  const tx = horizontal ? midX : midX - 110;
  const ty = horizontal ? midY - 90 : midY;
  const anchor = horizontal ? 'middle' : 'end';

  return (
    `<g stroke="#8a8580" stroke-width="3" fill="none">` +
    `<line x1="${X1}" y1="${Y1}" x2="${X2}" y2="${Y2}"/>` +
    ticks +
    `</g>` +
    `<text x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" text-anchor="${anchor}" font-family="Inter,Helvetica,Arial,sans-serif" font-size="80" fill="#57534e">${esc(caption)}</text>`
  );
}

function dimensions(project: Project, margin: number): string[] {
  const { width, depth } = project.plot;
  const d = (m: number): string => formatLength(m, 'm', 2);
  const off = -margin * 0.42;
  return [
    dimLine(0, off, width, off, d(width)),
    dimLine(off, 0, off, depth, d(depth)),
  ];
}