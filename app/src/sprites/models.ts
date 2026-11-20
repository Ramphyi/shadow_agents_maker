/**
 * Sprites are drawn as 12×12 pixel art (front view) and inflated into voxels by the engine:
 * every pixel becomes a column of cubes, thicker toward the middle of the shape.
 *
 *   .  empty        b  body (the agent's color)     d  body, darker     l  body, lighter
 *   a  accent       w  white                        e  eye (near black) k  black
 *
 * w, e and k are painted on the front face only; the cubes behind them use the body color.
 */
export type SpriteId = 'wisp' | 'fox' | 'owl' | 'bot' | 'slime' | 'cat' | 'mage' | 'crow';

export const SPRITE_INFO: Record<SpriteId, { label: string; hint: string }> = {
  wisp: { label: 'Wisp', hint: 'A quiet ghost. Good all-rounder.' },
  fox: { label: 'Fox', hint: 'Quick and curious. Scouts and searches.' },
  owl: { label: 'Owl', hint: 'Watchful. Inboxes and monitors.' },
  bot: { label: 'Bot', hint: 'Methodical. Checks and pipelines.' },
  slime: { label: 'Slime', hint: 'Soaks things up. Notes and memory.' },
  cat: { label: 'Cat', hint: 'Independent. Does its own thing on schedule.' },
  mage: { label: 'Mage', hint: 'Coordinates the others. Briefings.' },
  crow: { label: 'Crow', hint: 'A messenger. Carries things between systems.' },
};

export const SPRITE_MAPS: Record<SpriteId, string[]> = {
  wisp: [
    '....llll....',
    '..llbbbbbb..',
    '.lbbbbbbbbb.',
    '.bbbbbbbbbb.',
    'bbwwbbbbwwbb',
    'bbwebbbbwebb',
    'bbbbbbbbbbbb',
    'bbbbbddbbbbb',
    'bbbbbbbbbbbb',
    'bbbbbbbbbbbd',
    'bbd.bbbd.bbd',
    'bd...bd...d.',
  ],
  fox: [
    'bb........bb',
    'bab......bab',
    'baabbbbbbaab',
    'bbbbbbbbbbbb',
    'bbbbbbbbbbbb',
    'bbwebbbbewbb',
    'wwwbbbbbbwww',
    'wwwwbbbbwwww',
    '.wwwwkkwwww.',
    '..wwwwwwww..',
    '...wwwwww...',
    '....dddd....',
  ],
  owl: [
    'bb........bb',
    'bbbbbbbbbbbb',
    'bbbbbbbbbbbb',
    'bwwwbbbbwwwb',
    'bwewbbbbwewb',
    'bwwwbaabwwwb',
    'bbbbbaabbbbb',
    'dbbllllllbbd',
    'dbllllllllbd',
    'dbllllllllbd',
    '.bbllllllbb.',
    '..aa....aa..',
  ],
  bot: [
    '.....aa.....',
    '.....dd.....',
    '.bbbbbbbbbb.',
    '.bkkkkkkkkb.',
    '.bkaakkaakb.',
    '.bkaakkaakb.',
    '.bkkkkkkkkb.',
    '.bbbbbbbbbb.',
    '..dbbbbbbd..',
    'd.bblbbbbb.d',
    'd.bbbbbbbb.d',
    '..dd....dd..',
  ],
  slime: [
    '............',
    '............',
    '....llll....',
    '..llbbbbbb..',
    '.lbbbbbbbbb.',
    '.bbbbbbbbbb.',
    'bbwwbbbbwwbb',
    'bbwebbbbwebb',
    'bbbbbbbbbbbb',
    'bbbbbddbbbbb',
    'dbbbbbbbbbbd',
    '.dddddddddd.',
  ],
  cat: [
    'b..........b',
    'bb........bb',
    'bab......bab',
    'bbbbbbbbbbbb',
    'bbbbbbbbbbbb',
    'bbwebbbbwebb',
    'bbwebbbbwebb',
    'bbbbbaabbbbb',
    'bbbdbbbbdbbb',
    '.bbbddddbbb.',
    '..bbbbbbbb..',
    '..dd....dd..',
  ],
  mage: [
    '.....bb.....',
    '....bbbb....',
    '....bbbl....',
    '...bbbbbb...',
    '..aaaaaaaa..',
    'bbbbbbbbbbbb',
    '..kkkkkkkk..',
    '..kwkkkkwk..',
    '..dddaaddd..',
    '.ddddaadddd.',
    '.ddddaadddd.',
    'dddddaaddddd',
  ],
  crow: [
    '....bbbb....',
    '...bbbbbb...',
    '..bbbbbbbb..',
    '..bwebbweb..',
    '..bbbaabbb..',
    '.bbbbaabbbb.',
    'dbbbbbbbbbbd',
    'ddbbbbbbbbdd',
    'ddbbbbbbbbdd',
    '.dbbbbbbbbd.',
    '...bb..bb...',
    '..aa....aa..',
  ],
};

/** Small voxel glyphs that float above a sprite to show what it is doing. */
export const GLYPHS = {
  alert: ['.yy.', '.yy.', '.yy.', '....', '.yy.'],
  sleep: ['zzzz', '..z.', '.z..', 'zzzz'],
  error: ['r..r', '.rr.', '.rr.', 'r..r'],
};
