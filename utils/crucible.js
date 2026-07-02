import { renderCard, parseTypeLine } from 'mtg-crucible';

/**
 * Render a crucible CardData object to image bytes.
 * JPEG keeps the rendered art well under Archidekt's upload size limit while
 * staying visually high quality.
 *
 * allowUnsafeArtUrls is enabled so the agent can point artUrl at a local file
 * on this machine. This is a single-user, locally-run server acting on the
 * user's own account, so the SSRF/local-file risk the flag normally guards
 * against is acceptable here.
 * @param {object} cardData - A crucible CardData object
 * @returns {Promise<import('mtg-crucible').RenderedCard>}
 */
export async function renderCustomCard(cardData) {
  return renderCard(cardData, { quality: 'high', format: 'jpeg', allowUnsafeArtUrls: true });
}

/** File extension for a crucible RenderFormat. */
export function formatExtension(format) {
  return format === 'jpeg' ? 'jpg' : format;
}

/**
 * Convert the agent-facing card shape ({ faces: [front, back?] }) into a crucible
 * CardData object. A second face becomes crucible's linkedCard; crucible infers
 * the link type and per-face frame templates itself, so we never touch them.
 * colorIndicator is passed through as a WUBRG string, which crucible parses.
 * @param {object} agentCard - { faces: [frontFace, backFace?] }
 * @returns {object} crucible CardData
 */
export function toCrucibleCard(agentCard) {
  const [front, back] = agentCard.faces || [];
  const card = { ...front };
  if (back) card.linkedCard = { ...back };
  return card;
}

/**
 * Capitalize the first letter of each word.
 * @param {string} s
 * @returns {string}
 */
function titleCase(s) {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Roughly compute converted mana cost / mana value from a mana cost string.
 * @param {string} manaCost - e.g. "{2}{U}{U}"
 * @returns {number}
 */
export function manaCostToCmc(manaCost) {
  if (!manaCost) return 0;
  const tokens = manaCost.match(/\{([^}]+)\}/g) || [];
  let cmc = 0;
  for (const tok of tokens) {
    const inner = tok.slice(1, -1); // "2", "U", "U/R", "2/U", "X", "U/P", "C", "S"
    if (/^\d+$/.test(inner)) {
      cmc += parseInt(inner, 10);
    } else if (/^[XYZ]$/.test(inner)) {
      cmc += 0;
    } else if (inner.includes('/')) {
      // Hybrid: use the larger numeric side if present, otherwise counts as 1.
      const nums = inner.split('/').filter((p) => /^\d+$/.test(p)).map(Number);
      cmc += nums.length ? Math.max(...nums) : 1;
    } else {
      cmc += 1; // colored pip, colorless {C}, snow {S}, etc.
    }
  }
  return cmc;
}

/**
 * Map a single crucible face (CardData) to Archidekt custom-card fields.
 * @param {object} card - crucible CardData for one face
 * @param {string} prefix - 'front' or 'back'
 * @param {string|null} imageUrl - hosted image URL for this face
 * @returns {object}
 */
function faceToArchidekt(card, prefix, imageUrl) {
  let types = null;
  let subTypes = null;
  let superTypes = null;
  if (typeof card.typeLine === 'string' && card.typeLine.trim()) {
    const parsed = parseTypeLine(card.typeLine);
    types = parsed.types.length ? titleCase(parsed.types.join(' ')) : null;
    subTypes = parsed.subtypes.length ? parsed.subtypes.join(' ') : null;
    superTypes = parsed.supertypes.length ? titleCase(parsed.supertypes.join(' ')) : null;
  }

  const abilities = typeof card.abilities === 'string' ? card.abilities : null;

  return {
    [`${prefix}Name`]: card.name ?? null,
    [`${prefix}ManaCost`]: card.manaCost ?? null,
    [`${prefix}Text`]: abilities,
    [`${prefix}Power`]: card.power ?? null,
    [`${prefix}Toughness`]: card.toughness ?? null,
    [`${prefix}Loyalty`]: card.startingLoyalty ?? null,
    [`${prefix}Types`]: types,
    [`${prefix}SubTypes`]: subTypes,
    [`${prefix}SuperTypes`]: superTypes,
    [`${prefix}ImageUrl`]: imageUrl ?? null,
    [`${prefix}ArtistName`]: card.artist ?? null,
  };
}

/**
 * Convert a crucible CardData object (plus already-uploaded image URLs) into the
 * Archidekt custom-card payload shape.
 * @param {object} cardData - crucible CardData
 * @param {object} images
 * @param {string} images.frontImageUrl
 * @param {string} [images.backImageUrl]
 * @returns {object} Archidekt custom-card fields
 */
export function toArchidektCustomCard(cardData, { frontImageUrl, backImageUrl } = {}) {
  // TODO: better handle single-faced composite cards (split / adventure / omen /
  // room / aftermath / fuse / flip). crucible renders those as ONE image (no
  // backFace), but because they still carry a `linkedCard` we currently mark
  // hasBack=true and split the second part into back* fields with a null
  // backImageUrl — so Archidekt treats them as a double-faced card with a
  // missing back. These should map to a single Archidekt face (hasBack=false)
  // using the one composite image. `backImageUrl` is the reliable signal: it's
  // only set for true two-image DFCs (transform / modal DFC).
  const hasBack = !!cardData.linkedCard;

  return {
    cmc: manaCostToCmc(cardData.manaCost),
    setCode: cardData.setCode ?? null,
    collectorNumber: cardData.collectorNumber ?? null,
    hasBack,
    ...faceToArchidekt(cardData, 'front', frontImageUrl),
    ...faceToArchidekt(hasBack ? cardData.linkedCard : {}, 'back', hasBack ? backImageUrl : null),
  };
}
