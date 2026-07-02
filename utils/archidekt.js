const BASE_URL = 'https://archidekt.com/api';
const USER_AGENT = 'CommandTowerMCP/0.1.0';

// Cached auth state
let authCache = {
  accessToken: null,
  refreshToken: null,
  rootFolder: null,
  userId: null,
  username: null,
  expiresAt: null,
};

/**
 * Get valid access token, logging in if needed
 * Uses ARCHIDEKT_USERNAME and ARCHIDEKT_PASSWORD env vars
 * @returns {Promise<{accessToken: string, rootFolder: number, userId: number, username: string}>}
 */
export async function getAuth() {
  // Check if we have a valid cached token (with 5 min buffer)
  if (authCache.accessToken && authCache.expiresAt && Date.now() < authCache.expiresAt - 300000) {
    return { accessToken: authCache.accessToken, rootFolder: authCache.rootFolder, userId: authCache.userId, username: authCache.username };
  }

  const username = process.env.ARCHIDEKT_USERNAME;
  const password = process.env.ARCHIDEKT_PASSWORD;

  if (!username || !password) {
    throw new Error('ARCHIDEKT_USERNAME and ARCHIDEKT_PASSWORD environment variables are required');
  }

  const result = await login(username, password);

  // Cache the token (JWT typically expires in 1 hour, we'll assume 1 hour)
  authCache = {
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    rootFolder: result.rootFolder,
    userId: result.userId,
    username: result.username,
    expiresAt: Date.now() + 3600000, // 1 hour
  };

  return { accessToken: authCache.accessToken, rootFolder: authCache.rootFolder, userId: authCache.userId, username: authCache.username };
}

// Deck format constants
export const DECK_FORMATS = {
  STANDARD: 1,
  MODERN: 2,
  COMMANDER: 3,
  LEGACY: 4,
  VINTAGE: 5,
  PAUPER: 6,
  PIONEER: 7,
  BRAWL: 8,
  HISTORIC: 9,
  OATHBREAKER: 10,
};

/**
 * Login to Archidekt and get access token
 * @param {string} username
 * @param {string} password
 * @returns {Promise<{accessToken: string, refreshToken: string, rootFolder: number, userId: number, username: string, user: object}>}
 */
export async function login(username, password) {
  const response = await fetch(`${BASE_URL}/rest-auth/login/`, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({ username, password }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.non_field_errors?.[0] || `Login failed: ${response.status}`);
  }
  const data = await response.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    rootFolder: data.user.rootFolder,
    userId: data.user.id,
    username: data.user.username,
    user: data.user,
  };
}

/**
 * List user's decks
 * @param {string} accessToken
 * @returns {Promise<Array>}
 */
export async function listDecks(accessToken) {
  const response = await fetch(`${BASE_URL}/decks/curated/self/`, {
    headers: {
      'Accept': 'application/json',
      'Authorization': `JWT ${accessToken}`,
      'User-Agent': USER_AGENT,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to list decks: ${response.status}`);
  }

  const data = await response.json();
  return data.results;
}

/**
 * List the user's custom cards (their custom-card library).
 * Follows pagination so all cards are returned.
 * @param {string} accessToken
 * @returns {Promise<Array>}
 */
export async function listCustomCards(accessToken) {
  const results = [];
  let url = `${BASE_URL}/decks/customCards/?`;

  while (url) {
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'Authorization': `JWT ${accessToken}`,
        'User-Agent': USER_AGENT,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to list custom cards: ${response.status}`);
    }

    const data = await response.json();
    results.push(...(data.results || []));
    url = data.next || null;
  }

  return results;
}

/**
 * Get a deck by ID
 * @param {string} accessToken
 * @param {number} deckId
 * @returns {Promise<object>}
 */
export async function getDeck(accessToken, deckId) {
  const response = await fetch(`${BASE_URL}/decks/${deckId}/`, {
    headers: {
      'Accept': 'application/json',
      'Authorization': `JWT ${accessToken}`,
      'User-Agent': USER_AGENT,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to get deck: ${response.status}`);
  }

  return response.json();
}

/**
 * Create a new deck
 * @param {string} accessToken
 * @param {object} options
 * @param {string} options.name - Deck name
 * @param {number} options.parentFolder - Parent folder ID (use rootFolder from login)
 * @param {number} [options.deckFormat=3] - Deck format (default: Commander)
 * @param {string} [options.description='']
 * @param {boolean} [options.private=true]
 * @param {boolean} [options.unlisted=false]
 * @returns {Promise<object>}
 */
export async function createDeck(accessToken, options) {
  const {
    name,
    parentFolder,
    deckFormat = DECK_FORMATS.COMMANDER,
    description = '',
    private: isPrivate = true,
    unlisted = false,
  } = options;

  const response = await fetch(`${BASE_URL}/decks/v2/`, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Authorization': `JWT ${accessToken}`,
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({
      name,
      deckFormat,
      edhBracket: null,
      description,
      featured: '',
      playmat: '',
      private: isPrivate,
      unlisted,
      theorycrafted: false,
      game: null,
      parent_folder: parentFolder,
      cardPackage: null,
      extras: {
        decksToInclude: [],
        commandersToAdd: [],
        forceCardsToSingleton: false,
        ignoreCardsOutOfCommanderIdentity: true,
      },
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create deck: ${response.status} - ${error}`);
  }

  return response.json();
}

/**
 * Compute diff between current deck state and new edit
 * @param {string} accessToken
 * @param {string} currentDeckList - Current deck in Archidekt format
 * @param {string} editDeckList - New deck list to compare
 * @param {string} [parser='archidekt'] - Parser format
 * @returns {Promise<{toAdd: Array, toRemove: Array, cardErrors: Array, syntaxErrors: Array, categories: object}>}
 */
export async function computeDiff(accessToken, currentDeckList, editDeckList, parser = 'archidekt') {
  const response = await fetch(`${BASE_URL}/cards/massDeckEdit/`, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Authorization': `JWT ${accessToken}`,
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({
      parser,
      current: currentDeckList,
      edit: editDeckList,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to compute diff: ${response.status} - ${error}`);
  }

  return response.json();
}

/**
 * Modify cards in a deck (add, remove, or update)
 * @param {string} accessToken
 * @param {number} deckId
 * @param {Array<object>} cards - Array of card modifications
 * @returns {Promise<{add: Array, createdCategories: Array}>}
 */
export async function modifyCards(accessToken, deckId, cards) {
  const response = await fetch(`${BASE_URL}/decks/${deckId}/modifyCards/v2/`, {
    method: 'PATCH',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Authorization': `JWT ${accessToken}`,
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({ cards }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to modify cards: ${response.status} - ${error}`);
  }

  return response.json();
}

/**
 * Helper to create an "add" card action
 * @param {object} options
 * @param {string} options.cardId - Archidekt card ID
 * @param {number} [options.quantity=1]
 * @param {Array<string>} [options.categories=[]]
 * @param {string} [options.modifier='Normal'] - 'Normal' or 'Foil'
 * @param {string} [options.label=',#656565'] - Label and color
 * @returns {object}
 */
export function createAddCardAction(options) {
  const {
    cardId,
    quantity = 1,
    categories = [],
    modifier = 'Normal',
    label = ',#656565',
  } = options;

  return {
    action: 'add',
    cardid: cardId,
    customCardId: null,
    categories,
    patchId: generatePatchId(),
    modifications: {
      quantity,
      modifier,
      customCmc: null,
      companion: false,
      flippedDefault: false,
      label,
    },
  };
}

/**
 * Helper to create a "remove" card action
 * @param {object} options
 * @param {string} options.cardId - Archidekt card ID
 * @param {string} options.deckRelationId - The deck relation ID from the deck
 * @param {number} [options.quantity=1]
 * @param {Array<string>} [options.categories=[]]
 * @param {string} [options.modifier='Normal']
 * @param {string} [options.label=',#656565']
 * @returns {object}
 */
export function createRemoveCardAction(options) {
  const {
    cardId,
    deckRelationId,
    quantity = 1,
    categories = [],
    modifier = 'Normal',
    label = ',#656565',
  } = options;

  return {
    action: 'remove',
    cardid: cardId,
    customCardId: null,
    categories,
    patchId: generatePatchId(),
    modifications: {
      quantity,
      modifier,
      customCmc: null,
      companion: false,
      flippedDefault: false,
      label,
    },
    deckRelationId,
  };
}

/**
 * Upload an image to Archidekt and get back a hosted URL.
 * The body is the raw image bytes; the server validates PNG/JPG magic bytes.
 * @param {string} accessToken
 * @param {Buffer|Uint8Array|string} image - Raw image bytes, or a base64 string (no data: prefix)
 * @param {string} [filename='tmp.png']
 * @returns {Promise<string>} The hosted image URL
 */
export async function uploadImage(accessToken, image, filename = 'tmp.png') {
  const body = typeof image === 'string' ? Buffer.from(image, 'base64') : image;

  const response = await fetch(`${BASE_URL}/users/uploadImage/`, {
    method: 'PUT',
    headers: {
      'Accept': '*/*',
      'Authorization': `JWT ${accessToken}`,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'User-Agent': USER_AGENT,
    },
    body,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to upload image: ${response.status} - ${error}`);
  }

  const data = await response.json();
  return data.imageUrl;
}

/**
 * Create a custom card. The card shape mirrors the Archidekt customCards API.
 * @param {string} accessToken
 * @param {number} ownerId - The owning user's ID
 * @param {object} card - Custom card fields (front/back faces etc.), owner is set automatically
 * @returns {Promise<object>} The created custom card (includes its new `id`)
 */
export async function createCustomCard(accessToken, ownerId, card) {
  const payload = {
    owner: ownerId,
    cmc: 0,
    frontName: null,
    frontManaCost: null,
    frontText: null,
    frontPower: null,
    frontToughness: null,
    frontLoyalty: null,
    frontTypes: null,
    frontSubTypes: null,
    frontSuperTypes: null,
    frontImageUrl: null,
    frontArtistName: null,
    hasBack: false,
    backName: null,
    backManaCost: null,
    backText: null,
    backPower: null,
    backToughness: null,
    backLoyalty: null,
    backTypes: null,
    backSubTypes: null,
    backSuperTypes: null,
    backImageUrl: null,
    backArtistName: null,
    setCode: null,
    collectorNumber: null,
    ...card,
    owner: ownerId,
  };

  const response = await fetch(`${BASE_URL}/decks/customCards/`, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Authorization': `JWT ${accessToken}`,
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({ customCards: [payload] }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create custom card: ${response.status} - ${error}`);
  }

  const data = await response.json();
  return data.customCards?.[0] || data;
}

/**
 * Update an existing custom card by ID (PATCH). Send the full field set to
 * replace its content.
 * @param {string} accessToken
 * @param {number} customCardId
 * @param {object} card - Archidekt custom-card fields (front/back faces, cmc, etc.)
 * @returns {Promise<object>} The updated custom card
 */
export async function updateCustomCard(accessToken, customCardId, card) {
  const response = await fetch(`${BASE_URL}/decks/customCards/${customCardId}/`, {
    method: 'PATCH',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Authorization': `JWT ${accessToken}`,
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify(card),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to update custom card: ${response.status} - ${error}`);
  }

  return response.json();
}

/**
 * Delete a custom card from the user's library by ID.
 * @param {string} accessToken
 * @param {number} customCardId
 * @returns {Promise<void>}
 */
export async function deleteCustomCard(accessToken, customCardId) {
  const response = await fetch(`${BASE_URL}/decks/customCards/${customCardId}/`, {
    method: 'DELETE',
    headers: {
      'Accept': 'application/json',
      'Authorization': `JWT ${accessToken}`,
      'User-Agent': USER_AGENT,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to delete custom card: ${response.status} - ${error}`);
  }
}

/**
 * Helper to create an "add" action for a custom card.
 * Custom cards are added by customCardId with cardid set to null.
 * @param {object} options
 * @param {number} options.customCardId - The custom card's ID
 * @param {number} [options.quantity=1]
 * @param {Array<string>} [options.categories=[]]
 * @param {string} [options.modifier='Normal']
 * @param {string} [options.label=',#656565']
 * @returns {object}
 */
export function createAddCustomCardAction(options) {
  const {
    customCardId,
    quantity = 1,
    categories = [],
    modifier = 'Normal',
    label = ',#656565',
  } = options;

  return {
    action: 'add',
    cardid: null,
    customCardId,
    categories,
    patchId: generatePatchId(),
    modifications: {
      quantity,
      modifier,
      customCmc: null,
      companion: false,
      flippedDefault: false,
      label,
    },
  };
}

/**
 * Helper to create a "remove" action for a custom card.
 * @param {object} options
 * @param {number} options.customCardId - The custom card's ID
 * @param {string} options.deckRelationId - The deck relation ID from the deck
 * @param {number} [options.quantity=1]
 * @param {Array<string>} [options.categories=[]]
 * @param {string} [options.modifier='Normal']
 * @param {string} [options.label=',#656565']
 * @returns {object}
 */
export function createRemoveCustomCardAction(options) {
  const {
    customCardId,
    deckRelationId,
    quantity = 1,
    categories = [],
    modifier = 'Normal',
    label = ',#656565',
  } = options;

  return {
    action: 'remove',
    cardid: null,
    customCardId,
    categories,
    patchId: generatePatchId(),
    modifications: {
      quantity,
      modifier,
      customCmc: null,
      companion: false,
      flippedDefault: false,
      label,
    },
    deckRelationId,
  };
}

/**
 * Generate a random patch ID for card operations
 * @returns {string}
 */
function generatePatchId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  let result = '';
  for (let i = 0; i < 10; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}
