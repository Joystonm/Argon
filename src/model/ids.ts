/**
 * Stable element identifiers.
 *
 * IDs look like `rm_k3f9x2a1`. They are:
 *   - prefixed by element type, so a mistyped tool argument fails loudly
 *     ("room rm_… not found") rather than silently matching the wrong object
 *   - unique without a counter, so undo/redo never reuses an id and a stale
 *     agent reference can never resolve to a different object
 *   - deterministic in shape but not in value, so they survive JSON round-trips
 */

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

let counter = 0;

/** Monotonic, collision-resistant suffix. */
function token(): string {
  counter = (counter + 1) % 0xffffff;
  const time = Date.now().toString(36);
  let rand = '';
  for (let i = 0; i < 4; i++) {
    rand += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return `${time}${counter.toString(36)}${rand}`;
}

export type IdPrefix =
  | 'p' // project
  | 'fl' // floor
  | 'rm' // room
  | 'wl' // wall
  | 'op' // opening
  | 'st' // staircase
  | 'od' // outdoor space
  | 'fu' // furniture
  | 'ul' // underlay
  | 'is'; // issue

export const newId = (prefix: IdPrefix): string => `${prefix}_${token()}`;

export const isId = (s: unknown, prefix?: IdPrefix): s is string =>
  typeof s === 'string' && /^[a-z]{2}_[0-9a-z]{6,}$/.test(s) && (!prefix || s.startsWith(`${prefix}_`));

/** Which element type does this id refer to? */
export function idKind(s: string): string | null {
  const m = /^([a-z]{2})_/.exec(s);
  return m ? m[1]! : null;
}

/** Reset the counter — only used by tests to keep ids reproducible. */
export function __resetIdCounter(): void {
  counter = 0;
}