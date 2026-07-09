// Deck legality checking, driven entirely by the data Archidekt already returns
// on GET /decks/{id}/ — no extra Scryfall calls. Each real card carries
// `card.rarity` (the printing's rarity) and `card.oracleCard.legalities` (an
// object keyed by format name, values 'legal' | 'not_legal' | 'banned' |
// 'restricted' | null), plus a few PDH-specific flags like `isPDHCommander`.

// Archidekt deckFormat IDs, verified against live Archidekt data (2026-07).
// `legality` is the key to read out of each card's oracleCard.legalities.
// `commanderStyle` formats are singleton and enforce the commander's color
// identity. `pdh` (Pauper EDH) gets its own per-card logic (see below).
export const ARCHIDEKT_FORMATS = {
  1:  { name: 'Standard',        legality: 'standard' },
  2:  { name: 'Modern',          legality: 'modern' },
  3:  { name: 'Commander',       legality: 'commander',       commanderStyle: true },
  4:  { name: 'Legacy',          legality: 'legacy' },
  5:  { name: 'Vintage',         legality: 'vintage' },
  6:  { name: 'Pauper',          legality: 'pauper' },
  7:  { name: 'Custom',          legality: null },
  8:  { name: 'Frontier',        legality: 'frontier' },
  11: { name: '1v1 Commander',   legality: 'commander',       commanderStyle: true },
  12: { name: 'Duel Commander',  legality: 'duel',            commanderStyle: true },
  14: { name: 'Oathbreaker',     legality: 'oathbreaker',     commanderStyle: true },
  15: { name: 'Pioneer',         legality: 'pioneer' },
  17: { name: 'Pauper EDH',      legality: 'paupercommander', commanderStyle: true, pdh: true },
  20: { name: 'Brawl',           legality: 'brawl',           commanderStyle: true },
  22: { name: 'Premodern',       legality: 'premodern' },
  23: { name: 'PreDH',           legality: 'predh',           commanderStyle: true },
};

// Format names/aliases accepted by create_deck -> Archidekt deckFormat ID.
const FORMAT_ALIASES = {
  standard: 1,
  modern: 2,
  commander: 3, edh: 3,
  legacy: 4,
  vintage: 5,
  pauper: 6,
  custom: 7,
  frontier: 8,
  '1v1': 11, '1v1 commander': 11,
  duel: 12, 'duel commander': 12,
  oathbreaker: 14,
  pioneer: 15,
  'pauper edh': 17, 'pauper commander': 17, paupercommander: 17, pdh: 17, pedh: 17,
  brawl: 20,
  premodern: 22,
  predh: 23,
};

const DEFAULT_FORMAT_ID = 3; // Commander

/** Map a user-supplied format name to an Archidekt deckFormat ID (defaults to Commander). */
export function getFormatId(format) {
  if (!format) return DEFAULT_FORMAT_ID;
  return FORMAT_ALIASES[format.toLowerCase().trim()] ?? DEFAULT_FORMAT_ID;
}

/** Human-readable name for an Archidekt deckFormat ID. */
export function getFormatName(id) {
  return ARCHIDEKT_FORMATS[id]?.name || `Format #${id}`;
}

// Cards legal in Pauper but banned specifically in Pauper EDH — the entire PDH
// banlist. Archidekt's `paupercommander` legality already reflects these (they
// come back as 'banned'), but we hardcode them as a safety net in case that
// field is ever missing or stale.
const PDH_BANLIST = new Set(['Rhystic Study', 'Mystic Remora']);

/**
 * Pauper EDH legality for a card sitting in the 99 (i.e. not the commander).
 * Returns 'legal' | 'banned' | 'not_legal'.
 *
 * Prefers Archidekt's `paupercommander` legality, which already encodes the PDH
 * rules: a card is 'legal' if it has a common printing, 'banned' if on the PDH
 * banlist, 'not_legal' otherwise. If that field is absent we derive it from
 * Pauper legality: 'legal' in Pauper means a common printing exists, and — the
 * key PDH quirk — 'banned' in Pauper *also* implies a common printing exists, so
 * it's legal in PDH (Pauper bans don't carry over). Only 'not_legal' in Pauper
 * (no common printing) is illegal in the PDH 99.
 */
export function pdhLegalityInNinetyNine(oracle) {
  if (PDH_BANLIST.has(oracle.name)) return 'banned';

  const pc = oracle.legalities?.paupercommander;
  if (pc === 'legal' || pc === 'banned' || pc === 'not_legal') return pc;

  const pauper = oracle.legalities?.pauper;
  if (pauper === 'legal' || pauper === 'banned') return 'legal';
  return 'not_legal';
}

/**
 * Whether a deck card may serve as a Pauper EDH commander. PDH allows an
 * uncommon creature (and, per newer rules, cards Archidekt flags as
 * commander-eligible such as Backgrounds). Uses Archidekt's `isPDHCommander`
 * flag when present, falling back to "uncommon creature" from the printing's
 * rarity and type line.
 * @param {object} card - A deck.cards[] entry (has `.card.rarity` and `.card.oracleCard`).
 */
export function isLegalPdhCommander(card) {
  const oracle = card.card.oracleCard;
  if (oracle.isPDHCommander === true) return true;
  if (oracle.isPDHCommander === false) return false;
  return card.card.rarity === 'uncommon' && oracle.types?.includes('Creature');
}

/**
 * Check a deck's real cards for format-legality problems and return an array of
 * human-readable issue strings.
 *
 * All checks read data already present on the Archidekt deck response, so this
 * makes zero API calls. Commander-style formats additionally get color-identity
 * and singleton checks; Pauper EDH (deckFormat 17) gets dedicated per-card
 * legality using the commander/99 split described above.
 *
 * @param {Array} cards - deck.cards (real cards only; custom cards are excluded).
 * @param {number} deckFormat - Archidekt deckFormat ID.
 * @returns {Array<string>}
 */
export function getLegalityIssues(cards, deckFormat) {
  const meta = ARCHIDEKT_FORMATS[deckFormat] || {};
  const issues = [];

  const commanders = cards.filter(c => c.categories?.includes('Commander'));

  // Collect the commander(s)' combined color identity (commander-style formats).
  const commanderColors = new Set();
  if (meta.commanderStyle) {
    for (const cmd of commanders) {
      for (const color of cmd.card.oracleCard.colorIdentity || []) {
        commanderColors.add(color);
      }
    }
  }

  for (const c of cards) {
    const oracle = c.card.oracleCard;
    const name = oracle.name;
    const isCommander = c.categories?.includes('Commander');

    // Per-card format legality.
    if (meta.pdh) {
      if (isCommander) {
        // The commander is the one card allowed to be uncommon.
        if (!isLegalPdhCommander(c)) {
          issues.push(`${name} is not a legal Pauper EDH commander (must be an uncommon creature)`);
        }
      } else {
        const status = pdhLegalityInNinetyNine(oracle);
        if (status === 'banned') {
          issues.push(`${name} is banned in Pauper EDH`);
        } else if (status !== 'legal') {
          issues.push(`${name} is not legal in Pauper EDH (no common printing)`);
        }
      }
    } else if (meta.legality) {
      const legality = oracle.legalities?.[meta.legality];
      if (legality && legality !== 'legal') {
        issues.push(`${name} is ${legality} in ${meta.name}`);
      }
    }

    // Color-identity violations vs. the commander (commander-style formats).
    if (meta.commanderStyle && !isCommander && commanders.length > 0) {
      for (const color of oracle.colorIdentity || []) {
        if (!commanderColors.has(color)) {
          issues.push(`${name} has ${color} in its color identity, outside commander's identity`);
          break;
        }
      }
    }
  }

  // Singleton check (commander-style formats): at most one of each non-basic card.
  if (meta.commanderStyle) {
    const totalsByName = {};
    for (const c of cards) {
      const name = c.card.oracleCard.name;
      totalsByName[name] = (totalsByName[name] || 0) + c.quantity;
    }
    for (const c of cards) {
      const oracle = c.card.oracleCard;
      const name = oracle.name;
      const isBasicLand = oracle.superTypes?.includes('Basic') && oracle.types?.includes('Land');
      if (totalsByName[name] > 1 && !isBasicLand) {
        issues.push(`${name} has ${totalsByName[name]} copies (singleton violation)`);
        delete totalsByName[name]; // only report once
      }
    }
  }

  return issues;
}
