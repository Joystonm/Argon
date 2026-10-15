/**
 * SVG plan export.
 *
 * The brief is blunt about this: never claim a file format is supported unless
 * the export can actually be opened and used. So these tests do not merely
 * check that a string was returned — they parse it, check that every tag is
 * closed in the right order, and then check the numbers in the document against
 * the model, because a well-formed file that draws the wrong geometry is still
 * a lie.
 *
 * There is no XML parser in the dependency tree, so `assertWellFormed` below is
 * a real tag-stack walk rather than a regex. It is not a full XML 1.0
 * implementation, but it does catch unclosed elements, mismatched nesting,
 * unquoted attributes and unescaped `<` in text — which is the whole class of
 * "this file will not open" bugs.
 */
import { describe, expect, it } from 'vitest';
import { planToSvg } from './planSvg.ts';
import {
  addFloor,
  addFurniture,
  addOpening,
  blankProject,
  createRoom,
  createWall,
  setPlot,
} from '../model/ops.ts';
import { OPENING_DEFAULTS } from '../model/catalog.ts';
import type { Project } from '../model/types.ts';

/**
 * Walk every tag, checking nesting and attribute quoting.
 *
 * Returns the element names in document order so callers can count them.
 */
function assertWellFormed(svg: string): string[] {
  const prolog = '<?xml version="1.0" encoding="UTF-8"?>';
  expect(svg.startsWith(prolog)).toBe(true);

  const stack: string[] = [];
  const names: string[] = [];
  const tag = /<(\/?)([a-zA-Z][\w:-]*)((?:\s+[\w:-]+\s*=\s*"[^"<>]*")*)\s*(\/?)>/g;

  // Everything outside tags must have no bare `<` and no unescaped `&`.
  // Scanning starts after the prolog, which is not an element.
  const body = svg.slice(prolog.length);
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(body)) !== null) {
    const text = body.slice(cursor, m.index);
    expect(text, `unescaped "<" before ${m[2]}`).not.toMatch(/<(?!$)/);
    expect(text, `unescaped "&" before ${m[2]}`).not.toMatch(/&(?!#\d+;|#x[\da-fA-F]+;|\w+;)/);
    cursor = m.index + m[0].length;

    const [, closing, name, attrs, selfClose] = m;
    names.push(name);
    if (closing) {
      expect(stack.pop(), `closing <${name}> does not match`).toBe(name);
    } else if (!selfClose) {
      stack.push(name!);
    }
    void attrs;
  }

  const tail = body.slice(cursor);
  expect(tail, 'trailing content after the last tag').not.toMatch(/[<>]/);
  expect(stack, `unclosed elements: ${stack.join(', ')}`).toEqual([]);
  return names;
}

function base(): Project {
  const p = blankProject('Export test');
  const plot = setPlot(p, { width: 20, depth: 16, orientation: 0, setbacks: { front: 2, rear: 2, left: 2, right: 2 } });
  if (!plot.ok) throw new Error(plot.error);
  return plot.project;
}

function withRoom(): { p: Project; id: string } {
  const p = base();
  const r = createRoom(p, { floorId: p.floors[0]!.id, kind: 'living', x: 3, y: 3, width: 6, depth: 4 });
  if (!r.ok) throw new Error(r.error);
  return { p: r.project, id: r.createdIds[0]! };
}

const ground = (p: Project): string => p.floors[0]!.id;

describe('planToSvg produces a document that opens', () => {
  it('is well-formed XML with one svg root', () => {
    const { p } = withRoom();
    const svg = planToSvg(p, ground(p))!;
    const names = assertWellFormed(svg);
    expect(names[0]).toBe('svg');
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it('carries a title and a description for accessibility', () => {
    const { p } = withRoom();
    const svg = planToSvg(p, ground(p))!;
    assertWellFormed(svg);
    expect(svg).toContain('<title>Export test');
    expect(svg).toMatch(/<desc>[^<]*millimetres[^<]*<\/desc>/);
  });

  it('escapes a label containing markup instead of emitting broken XML', () => {
    const p = base();
    const r = createRoom(p, { floorId: p.floors[0]!.id, kind: 'living', label: 'Bed & Bath <spare>', x: 3, y: 3, width: 6, depth: 4 });
    if (!r.ok) throw new Error(r.error);
    const svg = planToSvg(r.project, ground(r.project))!;
    assertWellFormed(svg);
    expect(svg).toContain('Bed &amp; Bath &lt;spare&gt;');
    expect(svg).not.toContain('<spare>');
  });
});

describe('the exported document is geometrically true', () => {
  it('writes millimetres, so a 6 m × 4 m room is 6000 × 4000 units', () => {
    const { p } = withRoom();
    const svg = planToSvg(p, ground(p))!;
    assertWellFormed(svg);
    // x=3 m, y=3 m from the origin, in mm.
    expect(svg).toContain('<rect x="3000.00" y="3000.00" width="6000.00" height="4000.00"');
  });

  it('sizes the page from the plot plus the dimension margin', () => {
    const { p } = withRoom();
    const svg = planToSvg(p, ground(p))!;
    // 20 m + 16 m plot, and a 1400 mm margin on each side.
    const expected = `width="${20000 + 2800}mm" height="${16000 + 2800}mm"`;
    expect(svg).toContain(expected);
  });

  it('declares a viewBox that matches the page exactly', () => {
    const { p } = withRoom();
    const svg = planToSvg(p, ground(p))!;
    // viewBox starts at -1400 so the dimension chain above the plot is visible.
    expect(svg).toContain('viewBox="-1400 -1400 22800 18800"');
  });

  it('leaves y growing downward, matching the plan convention with no flip', () => {
    // A transform that negated y would be easy to add and would silently
    // mirror every plan; the document must not contain one.
    const { p } = withRoom();
    const svg = planToSvg(p, ground(p))!;
    expect(svg).not.toMatch(/scale\([^)]*-\s*1/);
    expect(svg).toContain('<g transform="translate(1400 1400)">');
  });

  it('draws the buildable envelope inset by the setbacks', () => {
    const { p } = withRoom();
    const svg = planToSvg(p, ground(p))!;
    // Plot 20 × 16 with 2 m setbacks: the envelope is 16 m × 12 m at (2, 2).
    expect(svg).toContain('<rect x="2000.00" y="2000.00" width="16000.00" height="12000.00"');
  });

  it('labels a room with its true area', () => {
    const { p } = withRoom();
    const svg = planToSvg(p, ground(p))!;
    expect(svg).toContain('24.0 m²');
  });

  it('draws a wall as its real outline, at its real thickness', () => {
    const p = base();
    const w = createWall(p, { floorId: p.floors[0]!.id, type: 'exterior', a: { x: 2, y: 2 }, b: { x: 12, y: 2 } });
    if (!w.ok) throw new Error(w.error);
    expect(w.project.walls[0]!.thickness).toBeCloseTo(0.23, 6);
    const svg = planToSvg(w.project, ground(w.project))!;
    assertWellFormed(svg);

    // A 10 m wall centred on y = 2 m: its faces sit at 2 ± 0.115 m.
    expect(svg).toContain('<polygon points="2000.00 1885.00 12000.00 1885.00 12000.00 2115.00 2000.00 2115.00"');
    const pts = [...svg.matchAll(/<polygon points="([^"]+)"/g)][0]![1]!.split(' ').map(Number);
    // Eight numbers: four corner pairs, so y sits at the odd indices. The two
    // *distinct* faces are y[0] and y[2]; 0.23 m is 230 mm apart.
    const faces = [pts[1]!, pts[5]!];
    expect(Math.abs(faces[0]! - faces[1]!)).toBeCloseTo(230, 2);
    expect(pts[1]).toBe(1885);
    expect(pts[5]).toBe(2115);
  });

  it('knocks an opening out of the wall by drawing piers instead', () => {
    const p = base();
    const plain = createWall(p, { floorId: p.floors[0]!.id, type: 'exterior', a: { x: 2, y: 2 }, b: { x: 12, y: 2 } });
    if (!plain.ok) throw new Error(plain.error);
    // A 0.9 m door centred 5 m along the wall, which starts at x = 2.
    const cut = addOpening(plain.project, { wallId: plain.createdIds[0]!, kind: 'door', offset: 5, ...openingSize('interiorDoor') });
    if (!cut.ok) throw new Error(cut.error);

    const before = planToSvg(plain.project, ground(plain.project))!;
    const after = planToSvg(cut.project, ground(cut.project))!;
    assertWellFormed(after);

    const count = (s: string) => (s.match(/<polygon /g) ?? []).length;
    expect(count(after)).toBeGreaterThan(count(before));
    // The opening spans 5 ± 0.45 m along the wall, so the piers run
    // x = 2 → 6.55 m and x = 7.45 m → 12 m, leaving a 0.9 m gap.
    expect(after).toContain('<polygon points="2000.00 1885.00 6550.00 1885.00 6550.00 2115.00 2000.00 2115.00"');
    expect(after).toContain('<polygon points="7450.00 1885.00 12000.00 1885.00 12000.00 2115.00 7450.00 2115.00"');
    // Nothing is drawn across the gap.
    expect(after).not.toMatch(/6550\.00 1885\.00 7450\.00/);
  });

  it('draws furniture at its rotated footprint', () => {
    const p = base();
    const r = createRoom(p, { floorId: p.floors[0]!.id, kind: 'bedroom', x: 3, y: 3, width: 5, depth: 4 });
    if (!r.ok) throw new Error(r.error);
    // `bed-double` is 1.5 m × 2.0 m.
    const f = addFurniture(r.project, { floorId: p.floors[0]!.id, catalogId: 'bed-double', roomId: r.createdIds[0]!, x: 5.5, y: 5, rotation: 90 });
    if (!f.ok) throw new Error(f.error);
    const svg = planToSvg(f.project, ground(f.project))!;
    assertWellFormed(svg);
    // Turned 90°, the footprint swaps: 1.5 × 2.0 draws as 2000 × 1500.
    expect(svg).toMatch(/<rect x="4500\.00" y="4250\.00" width="2000\.00" height="1500\.00" transform="rotate\(-90\.00 5500\.00 5000\.00\)"/);
  });
});

function openingSize(key: keyof typeof OPENING_DEFAULTS) {
  const d = OPENING_DEFAULTS[key];
  return { width: d.width, height: d.height, sill: d.sill };
}

describe('options genuinely change the output', () => {
  it('omits furniture when furniture is off', () => {
    const p = base();
    const r = createRoom(p, { floorId: p.floors[0]!.id, kind: 'bedroom', x: 3, y: 3, width: 5, depth: 4 });
    if (!r.ok) throw new Error(r.error);
    const f = addFurniture(r.project, { floorId: p.floors[0]!.id, catalogId: 'bed-double', roomId: r.createdIds[0]!, x: 5, y: 5 });
    if (!f.ok) throw new Error(f.error);

    const on = planToSvg(f.project, ground(f.project), { furniture: true })!;
    const off = planToSvg(f.project, ground(f.project), { furniture: false })!;
    assertWellFormed(off);
    expect(on).toContain('rotate(');
    expect(off).not.toContain('rotate(');
    expect(off.length).toBeLessThan(on.length);
  });

  it('omits area labels when labels are off', () => {
    const { p } = withRoom();
    const off = planToSvg(p, ground(p), { labels: false })!;
    assertWellFormed(off);
    expect(off).not.toContain('24.0 m²');
  });

  it('omits the dimension chain and uses the smaller margin when dimensions are off', () => {
    const { p } = withRoom();
    const off = planToSvg(p, ground(p), { dimensions: false })!;
    assertWellFormed(off);
    expect(off).toContain('viewBox="-900 -900 21800 17800"');
    expect((off.match(/text-anchor="middle"/g) ?? []).length).toBeLessThan(
      (planToSvg(p, ground(p), { dimensions: true })!.match(/text-anchor="middle"/g) ?? []).length,
    );
  });

  it('is stable: the same project twice gives byte-identical output', () => {
    // Determinism is what makes the export trustworthy as a deliverable.
    const { p } = withRoom();
    expect(planToSvg(p, ground(p))).toBe(planToSvg(p, ground(p)));
  });
});

describe('what the export will not claim', () => {
  it('says on the sheet that it is a concept, not a construction drawing', () => {
    const { p } = withRoom();
    const svg = planToSvg(p, ground(p))!;
    expect(svg).toMatch(/Not a construction drawing/);
    expect(svg).toMatch(/not a compliance certificate/);
  });
});

describe('edge cases', () => {
  it('returns null when the project has no floor at all', () => {
    const p = blankProject('Nothing');
    p.floors = [];
    expect(planToSvg(p, undefined)).toBeNull();
  });

  it('falls back to the first floor when asked for one that does not exist', () => {
    const { p } = withRoom();
    const svg = planToSvg(p, 'floor_that_does_not_exist')!;
    assertWellFormed(svg);
    expect(svg).toContain(p.floors[0]!.name);
  });

  it('exports an empty floor rather than failing', () => {
    const p = base();
    const svg = planToSvg(p, ground(p))!;
    assertWellFormed(svg);
    expect(svg).toContain('0 rooms');
  });

  it('skips a degenerate wall instead of emitting a broken polygon', () => {
    const p = base();
    const w = createWall(p, { floorId: p.floors[0]!.id, type: 'interior', a: { x: 5, y: 5 }, b: { x: 15, y: 5 } });
    if (!w.ok) throw new Error(w.error);
    // `createWall` refuses a zero-length wall, so the degenerate case is
    // reached by corrupting one — which is exactly what a bad import produces,
    // and the exporter must not emit NaN coordinates for it.
    const broken: Project = { ...w.project, walls: [{ ...w.project.walls[0]!, b: { x: 5, y: 5 } }] };
    const svg = planToSvg(broken, ground(broken))!;
    assertWellFormed(svg);
    expect(svg).not.toContain('NaN');
    expect(svg).not.toContain('<polygon');
  });

  it('exports only the floor asked for, not the whole building', () => {
    const p = base();
    const r = createRoom(p, { floorId: p.floors[0]!.id, kind: 'living', label: 'Downstairs', x: 3, y: 3, width: 4, depth: 4 });
    if (!r.ok) throw new Error(r.error);
    const up = addFloor(r.project, 'First floor');
    if (!up.ok) throw new Error(up.error);
    const top = createRoom(up.project, { floorId: up.createdIds[0]!, kind: 'bedroom', label: 'Upstairs bedroom', x: 3, y: 3, width: 4, depth: 4 });
    if (!top.ok) throw new Error(top.error);

    const downstairs = planToSvg(top.project, ground(top.project))!;
    const upstairs = planToSvg(top.project, top.project.floors[1]!.id)!;
    assertWellFormed(downstairs);
    assertWellFormed(upstairs);

    expect(downstairs).toContain('Downstairs');
    expect(downstairs).not.toContain('Upstairs bedroom');
    expect(upstairs).toContain('Upstairs bedroom');
    expect(upstairs).not.toContain('Downstairs');
    // Each sheet says which storey it is.
    expect(downstairs).toContain('Export test — Ground floor');
    expect(upstairs).toContain('Export test — First floor');
  });
});