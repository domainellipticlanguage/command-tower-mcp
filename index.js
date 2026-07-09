#!/usr/bin/env node

import 'dotenv/config';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import * as archidekt from './utils/archidekt.js';
import * as scryfall from './utils/scryfall.js';
import * as crucible from './utils/crucible.js';
import { getLegalityIssues, getFormatId, getFormatName } from './utils/legality.js';

const server = new Server(
  {
    name: 'command-tower-mcp',
    version: '0.1.0',
    description: 'Magic: The Gathering deck building tools for Archidekt and Scryfall. For additional research, use web search/fetch to access EDHREC.com (commander staples, synergies), CommanderSpellbook.com (combos), and MTGGoldfish.com (meta, prices).',
  },
  {
    capabilities: {
      tools: {},
      logging: {},
    },
  }
);

// Custom card IDs created during this server process. delete_custom_card only
// touches cards in this set — a best-effort guard so the agent can clean up its
// own mistakes but can't delete cards from earlier sessions. Lost on restart.
const sessionCustomCardIds = new Set();

// One face of a card. Kept intentionally minimal — the content of a card, not
// its styling. Frame color, rarity symbol, layout, etc. are inferred by
// mtg-crucible from the mana cost and type line. Defined once and reused for the
// front (top level) and the optional back face.
const CRUCIBLE_FACE_PROPERTIES = {
  name: { type: 'string', description: 'Card name' },
  manaCost: { type: 'string', description: 'Mana cost in braces, e.g. "{2}{U}{U}".' },
  typeLine: { type: 'string', description: 'Full type line, e.g. "Legendary Creature — Spirit Wizard"' },
  colorIndicator: { type: 'string', description: 'Color indicator letters (WUBRG), e.g. "U" or "URG" — for cards whose color is not conveyed by the mana cost (e.g. a colored card with a colorless mana cost, or a transform back face). Omit when the mana cost already shows the color.' },
  rarity: { type: 'string', enum: ['common', 'uncommon', 'rare', 'mythic'], description: 'Card rarity' },
  abilities: { type: 'string', description: 'Rules text. Use newlines to separate abilities. Mana/tap symbols in braces, e.g. "{T}: Add {U}". Planeswalker loyalty abilities like "+1: ..." are detected automatically.' },
  power: { type: 'string', description: 'Power, if a creature' },
  toughness: { type: 'string', description: 'Toughness, if a creature' },
  startingLoyalty: { type: 'string', description: 'Starting loyalty, if a planeswalker' },
  battleDefense: { type: 'string', description: 'Defense, if a battle' },
  flavorText: { type: 'string', description: 'Italic flavor text below the rules text' },
  artUrl: { type: 'string', description: 'Art for the card. Either a public image URL (e.g. https://.../art.jpg) or an absolute path to a local image file on this machine (e.g. /Users/me/art.png). Omit for a blank art box.' },
  artist: { type: 'string', description: 'Artist credit' },
};

const CRUCIBLE_FACE_SCHEMA = {
  type: 'object',
  properties: CRUCIBLE_FACE_PROPERTIES,
  required: ['name', 'typeLine'],
};

const CRUCIBLE_CARD_SCHEMA = {
  type: 'object',
  properties: {
    faces: {
      type: 'array',
      minItems: 1,
      maxItems: 2,
      description: 'The card\'s part(s). Provide one face for a normal card, or two for a multi-part card: transform or modal double-faced cards (front // back), split (two halves, e.g. Fire // Ice), adventure (a creature with a "... — Adventure" instant/sorcery), omen (a "... — Omen" part), room ("Enchantment — Room"), aftermath, fuse, or flip. The first face is the front/primary part; the second is the back/secondary part.',
      items: CRUCIBLE_FACE_SCHEMA,
    },
  },
  required: ['faces'],
};

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'create_deck',
        description: 'Create a new deck on Archidekt.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Name for the new deck',
            },
            format: {
              type: 'string',
              description: 'Deck format: commander, standard, modern, legacy, vintage, pauper, "pauper edh" (aka pdh), pioneer, brawl, oathbreaker, "duel commander", premodern, predh, custom',
              default: 'commander',
            },
            description: {
              type: 'string',
              description: 'Optional deck description',
            },
            private: {
              type: 'boolean',
              description: 'Whether the deck should be private (default: true)',
              default: true,
            },
          },
          required: ['name'],
        },
      },
      {
        name: 'list_decks',
        description: 'List all decks in your Archidekt account.',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
      {
        name: 'read_deck',
        description: 'Read the contents of an Archidekt deck. Returns a formatted list of card names.',
        inputSchema: {
          type: 'object',
          properties: {
            deck_id: {
              type: 'number',
              description: 'The Archidekt deck ID to read',
            },
          },
          required: ['deck_id'],
        },
      },
      {
        name: 'update_deck',
        description: 'Update cards in an Archidekt deck. Provide cards to add and/or remove as text lists.',
        inputSchema: {
          type: 'object',
          properties: {
            deck_id: {
              type: 'number',
              description: 'The Archidekt deck ID to update',
            },
            cards_to_add: {
              type: 'string',
              description: 'Cards to add. Use # headers for categories, e.g.:\n# Commander\n1 Kenrith, the Returned King\n# Ramp\n1 Sol Ring\n1 Arcane Signet\n\nTo add a custom card you made with create_custom_card, prefix its name with "Custom#" (these are not real cards, so Scryfall lookup does not apply), e.g.:\n1 Custom#Maelstrom Vibe-Brewer\nUse list_custom_cards to see available custom cards.',
            },
            cards_to_remove: {
              type: 'string',
              description: 'Cards to remove, one per line. Format: "2 Sol Ring" or "1x Lightning Bolt". Custom cards use the "Custom#" prefix, e.g. "1 Custom#Maelstrom Vibe-Brewer".',
            },
          },
          required: ['deck_id'],
        },
      },
      {
        name: 'create_custom_card',
        description: 'Create a custom Magic card and add it to your Archidekt custom-card library. Describe the card\'s content — name, type line, mana cost, rules text, power/toughness, etc. For a multi-part card (transform, modal double-faced, split, adventure, omen, room, aftermath, fuse, or flip), provide each part as an entry in `faces`. To put the card in a deck afterward, use update_deck with a "Custom#<name>" line.',
        inputSchema: CRUCIBLE_CARD_SCHEMA,
      },
      {
        name: 'edit_custom_card',
        description: 'Update a custom card you created earlier in this session. Re-renders the card and replaces its content in place (the card keeps its ID, so decks using it update automatically). Provide the full `faces` (it is a replace, not a partial update). Only cards created with create_custom_card during this session can be edited.',
        inputSchema: {
          type: 'object',
          properties: {
            custom_card_id: {
              type: 'number',
              description: 'The ID of the custom card to update (returned by create_custom_card).',
            },
            faces: CRUCIBLE_CARD_SCHEMA.properties.faces,
          },
          required: ['custom_card_id', 'faces'],
        },
      },
      {
        name: 'list_custom_cards',
        description: 'List the custom cards in your Archidekt library (created with create_custom_card). To add one to a deck, reference it in update_deck as "Custom#<name>".',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
      {
        name: 'delete_custom_card',
        description: 'Delete a custom card from your Archidekt library. For safety, only custom cards created during this session (with create_custom_card) can be deleted — use this to clean up cards you just made.',
        inputSchema: {
          type: 'object',
          properties: {
            custom_card_id: {
              type: 'number',
              description: 'The ID of the custom card to delete (returned by create_custom_card).',
            },
          },
          required: ['custom_card_id'],
        },
      },
      {
        name: 'lookup_cards',
        description: 'Look up Magic: The Gathering cards by name. Returns oracle text, mana cost, type, and other details. Use this to learn about unfamiliar cards.',
        inputSchema: {
          type: 'object',
          properties: {
            card_names: {
              type: 'string',
              description: 'Card names to look up, one per line (max 150)',
            },
          },
          required: ['card_names'],
        },
      },
      {
        name: 'search_cards',
        description: 'Search for Magic: The Gathering cards using Scryfall query syntax. Examples: "ci:simic t:creature cmc<=3" (Simic creatures 3 or less), "o:\\"draw a card\\" c:blue" (blue cards with draw), "otag:ramp ci:green" (green ramp cards), "t:legendary t:creature" (legendary creatures).',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Scryfall query string. Common filters: c: (color), ci: (color identity), t: (type), o: (oracle text), otag: (EDHREC tag), cmc: (mana value), pow: (power), tou: (toughness)',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of results to return (default 20, max 175)',
            },
            page: {
              type: 'number',
              description: 'Page number for paginated results (default 1)',
            },
            order: {
              type: 'string',
              description: 'Sort order: name, released (by date), edhrec (by popularity), cmc, color, rarity, power, toughness (default: name)',
            },
            include_text: {
              type: 'boolean',
              description: 'Include oracle text in results (default false)',
            },
            format: {
              type: 'string',
              description: 'Filter to cards legal in format: commander (default), modern, legacy, standard, pioneer, pauper, paupercommander (Pauper EDH), vintage, etc. Use "all" for no filter. Tip for Pauper EDH: "format:paupercommander" gives 99-legal (common) cards; add "r:uncommon t:creature" to find eligible commanders.',
            },
          },
          required: ['query'],
        },
      },
    ],
  };
});

// Legality checking and format-name/ID handling live in ./utils/legality.js
// (getLegalityIssues, getFormatId, getFormatName), imported above.

// Custom cards are referenced in deck text lists with a "Custom#" prefix, e.g.
// "1 Custom#Maelstrom Vibe-Brewer". They can't be resolved via Scryfall/diff,
// so we pull them out and handle them by customCardId separately.
const CUSTOM_CARD_PREFIX = 'custom#';

/**
 * Split a deck text list into custom-card references and the remaining text
 * (real cards, to be sent through the normal diff). Tracks "# Category" headers
 * so each custom card keeps the category it appeared under.
 * @param {string} text
 * @returns {{ customLines: Array<{quantity: number, name: string, category: string|null}>, remainingText: string }}
 */
function extractCustomCardLines(text) {
  if (!text) return { customLines: [], remainingText: '' };

  const customLines = [];
  const keptLines = [];
  let currentCategory = null;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      keptLines.push(rawLine);
      continue;
    }
    if (line.startsWith('#')) {
      currentCategory = line.replace(/^#+\s*/, '').trim() || null;
      keptLines.push(rawLine);
      continue;
    }

    // Card line: optional "1 " / "1x " quantity, then the name.
    const match = line.match(/^(?:(\d+)x?\s+)?(.+)$/i);
    const namePart = match[2].trim();
    if (match && namePart.toLowerCase().startsWith(CUSTOM_CARD_PREFIX)) {
      customLines.push({
        quantity: match[1] ? parseInt(match[1], 10) : 1,
        name: namePart.slice(CUSTOM_CARD_PREFIX.length).trim(),
        category: currentCategory,
      });
      // Intentionally not kept — handled out-of-band.
    } else {
      keptLines.push(rawLine);
    }
  }

  return { customLines, remainingText: keptLines.join('\n') };
}

// Whether a deck text list contains any real (non-custom, non-header) card lines.
function hasCardLines(text) {
  return text.split('\n').some((l) => {
    const t = l.trim();
    return t && !t.startsWith('#');
  });
}

// Validate the `faces` argument shared by create_custom_card / edit_custom_card.
// Returns an error message string, or null if valid. (minItems/maxItems in the
// schema is advisory — the SDK doesn't enforce it — so we check here.)
function validateFacesArg(faces) {
  if (!Array.isArray(faces) || faces.length < 1 || faces.length > 2) {
    return 'Provide `faces` with one face (normal card) or two (double-faced card).';
  }
  if (!faces[0].name?.trim()) {
    return 'The first face needs a name.';
  }
  return null;
}

// Render a card from agent args and upload its image(s), returning the Archidekt
// custom-card payload. Shared by create_custom_card and edit_custom_card.
async function renderAndBuildCard(accessToken, username, args) {
  // Normalize the agent-facing shape into a crucible CardData (folds the second
  // face into linkedCard), and stamp the designer credit unless one was given.
  const cardData = {
    ...crucible.toCrucibleCard(args),
    designer: args.designer || `${username} • command-tower-mcp`,
  };

  server.sendLoggingMessage({ level: 'info', data: `Rendering custom card: ${cardData.name}` });
  const rendered = await crucible.renderCustomCard(cardData);

  server.sendLoggingMessage({ level: 'info', data: 'Uploading rendered image(s)...' });
  const ext = crucible.formatExtension(rendered.format);
  const frontImageUrl = await archidekt.uploadImage(accessToken, rendered.frontFace, `front.${ext}`);
  let backImageUrl;
  if (rendered.backFace) {
    backImageUrl = await archidekt.uploadImage(accessToken, rendered.backFace, `back.${ext}`);
  }

  return crucible.toArchidektCustomCard(cardData, { frontImageUrl, backImageUrl });
}

// Format a created/updated custom card record into a short summary line set.
function summarizeCustomCard(card) {
  let output = '';
  if (card.frontTypes) {
    const typeLine = [card.frontSuperTypes, card.frontTypes].filter(Boolean).join(' ');
    output += `\nType: ${typeLine}${card.frontSubTypes ? ` — ${card.frontSubTypes}` : ''}`;
  }
  if (card.frontManaCost) output += `\nMana cost: ${card.frontManaCost}`;
  if (card.hasBack) output += `\nBack face: ${card.backName}`;
  if (card.frontImageUrl) output += `\nImage: ${card.frontImageUrl}`;
  if (card.hasBack && card.backImageUrl) output += `\nBack image: ${card.backImageUrl}`;
  return output;
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // create_deck
  if (name === 'create_deck') {
    try {
      const { accessToken, rootFolder } = await archidekt.getAuth();
      server.sendLoggingMessage({ level: 'info', data: `Creating deck: ${args.name}` });

      const deck = await archidekt.createDeck(accessToken, {
        name: args.name,
        parentFolder: rootFolder,
        deckFormat: getFormatId(args.format),
        description: args.description || '',
        private: args.private !== false,
      });

      return {
        content: [{
          type: 'text',
          text: `Created deck "${deck.name}" (ID: ${deck.id})\nURL: https://archidekt.com/decks/${deck.id}`,
        }],
      };
    } catch (error) {
      server.sendLoggingMessage({ level: 'error', data: `Create deck error: ${error.message}` });
      return {
        content: [{ type: 'text', text: `Failed to create deck: ${error.message}` }],
        isError: true,
      };
    }
  }

  // list_decks
  if (name === 'list_decks') {
    try {
      const { accessToken } = await archidekt.getAuth();
      server.sendLoggingMessage({ level: 'info', data: 'Fetching deck list...' });

      const decks = await archidekt.listDecks(accessToken);

      if (!decks || decks.length === 0) {
        return {
          content: [{ type: 'text', text: 'No decks found.' }],
        };
      }

      // Fetch details for each deck to get commander and description
      const deckPreviews = await Promise.all(
        decks.map(async (d) => {
          try {
            const deck = await archidekt.getDeck(accessToken, d.id);
            const format = getFormatName(deck.deckFormat);
            const privacy = deck.private ? '(private)' : '(public)';

            // Extract color identity from deck colors
            const colorOrder = ['W', 'U', 'B', 'R', 'G'];
            const colors = d.colors || {};
            const colorId = colorOrder.filter(c => colors[c] > 0).join('') || 'C';

            // Find commanders (cards in "Commander" category)
            const commanders = (deck.cards || [])
              .filter(c => c.categories?.includes('Commander'))
              .map(c => c.card.oracleCard.name);

            // Build preview
            const cardCount = (deck.cards || []).reduce((sum, c) => sum + (c.quantity || 1), 0);
            let preview = `**${deck.name}** (ID: ${d.id}) - ${colorId} ${format} ${privacy} [${cardCount} cards]`;
            if (commanders.length > 0) {
              preview += `\n  Commander: ${commanders.join(' & ')}`;
            }
            if (deck.description) {
              let desc = deck.description;
              // Parse Quill Delta format if present
              try {
                const parsed = JSON.parse(desc);
                if (parsed.ops && Array.isArray(parsed.ops)) {
                  desc = parsed.ops
                    .map(op => (typeof op.insert === 'string' ? op.insert : ''))
                    .join('')
                    .trim();
                }
              } catch {
                // Not JSON, use as-is
              }
              if (desc) {
                desc = desc.length > 500 ? desc.slice(0, 500) + '...' : desc;
                preview += `\n  Description: ${desc}`;
              }
            }
            return preview;
          } catch {
            // Fallback if deck details fail
            const format = getFormatName(d.deckFormat);
            const privacy = d.private ? '(private)' : '(public)';
            const colorOrder = ['W', 'U', 'B', 'R', 'G'];
            const colors = d.colors || {};
            const colorId = colorOrder.filter(c => colors[c] > 0).join('') || 'C';
            return `**${d.name}** (ID: ${d.id}) - ${colorId} ${format} ${privacy}`;
          }
        })
      );

      return {
        content: [{
          type: 'text',
          text: `Found ${decks.length} deck(s):\n\n${deckPreviews.join('\n\n')}`,
        }],
      };
    } catch (error) {
      server.sendLoggingMessage({ level: 'error', data: `List decks error: ${error.message}` });
      return {
        content: [{ type: 'text', text: `Failed to list decks: ${error.message}` }],
        isError: true,
      };
    }
  }

  // read_deck
  if (name === 'read_deck') {
    try {
      const { accessToken } = await archidekt.getAuth();
      server.sendLoggingMessage({ level: 'info', data: `Reading deck ${args.deck_id}...` });

      const deck = await archidekt.getDeck(accessToken, args.deck_id);
      const cards = deck.cards || [];
      const customCards = deck.customCards || [];

      if (cards.length === 0 && customCards.length === 0) {
        return {
          content: [{ type: 'text', text: `Deck "${deck.name}" is empty.` }],
        };
      }

      // Build unified display entries from real cards and custom cards.
      const entries = [
        ...cards.map(c => ({
          name: c.card.oracleCard.name,
          qty: c.quantity,
          category: c.categories?.[0] || 'Uncategorized',
          custom: false,
        })),
        ...customCards.map(c => ({
          name: c.card.frontName,
          qty: c.quantity,
          category: c.categories?.[0] || 'Uncategorized',
          custom: true,
        })),
      ];

      // Group entries by category
      const byCategory = {};
      for (const e of entries) {
        if (!byCategory[e.category]) byCategory[e.category] = [];
        byCategory[e.category].push(e);
      }

      // Calculate total card count
      const totalCards = entries.reduce((sum, e) => sum + e.qty, 0);

      // Format output
      let output = `# ${deck.name} — ${getFormatName(deck.deckFormat)} (${totalCards} cards)\n\n`;
      for (const [category, categoryCards] of Object.entries(byCategory)) {
        const categoryCount = categoryCards.reduce((sum, e) => sum + e.qty, 0);
        output += `# ${category} (${categoryCount})\n`;
        for (const e of categoryCards) {
          output += `${e.qty}x ${e.name}${e.custom ? ' [custom]' : ''}\n`;
        }
        output += '\n';
      }

      output += `Total: ${totalCards} cards\n\n`;

      const issues = getLegalityIssues(cards, deck.deckFormat);

      output += `# Legality — ${getFormatName(deck.deckFormat)}\n`;
      if (issues.length === 0) {
        output += `No legality issues found.\n`;
      } else {
        output += `${issues.length} issue(s):\n`;
        for (const issue of issues) {
          output += `- ${issue}\n`;
        }
      }

      return {
        content: [{ type: 'text', text: output.trim() }],
      };
    } catch (error) {
      server.sendLoggingMessage({ level: 'error', data: `Read deck error: ${error.message}` });
      return {
        content: [{ type: 'text', text: `Failed to read deck: ${error.message}` }],
        isError: true,
      };
    }
  }

  // update_deck
  if (name === 'update_deck') {
    const { deck_id, cards_to_add, cards_to_remove } = args;

    if (!cards_to_add && !cards_to_remove) {
      return {
        content: [{ type: 'text', text: 'Please provide cards_to_add and/or cards_to_remove.' }],
        isError: true,
      };
    }

    try {
      const { accessToken } = await archidekt.getAuth();
      server.sendLoggingMessage({ level: 'info', data: `Fetching deck ${deck_id}...` });

      // Get current deck state
      const deck = await archidekt.getDeck(accessToken, deck_id);
      const issuesBefore = new Set(getLegalityIssues(deck.cards || [], deck.deckFormat));

      // Build current deck list string from deck cards
      const currentCards = deck.cards || [];
      const currentDeckList = currentCards.map(c => {
        const card = c.card;
        const qty = c.quantity;
        const edition = card.edition?.editioncode || '';
        const categories = c.categories?.length ? ` [${c.categories.join(', ')}]` : '';
        return `${qty}x ${card.oracleCard.name} (${edition})${categories}`;
      }).join('\n');

      // Pull custom-card references ("Custom#Name") out of the add/remove lists;
      // they're resolved by customCardId, not through the name-resolving diff.
      const addExtract = extractCustomCardLines(cards_to_add || '');
      const removeExtract = extractCustomCardLines(cards_to_remove || '');

      const cardActions = [];
      const warnings = [];
      let diffResult = { toAdd: [], cardErrors: [] };

      // Real cards to add: resolve names via the diff endpoint.
      if (hasCardLines(addExtract.remainingText)) {
        server.sendLoggingMessage({ level: 'info', data: 'Computing diff...' });
        diffResult = await archidekt.computeDiff(
          accessToken,
          currentDeckList,
          addExtract.remainingText
        );

        for (const item of diffResult.toAdd || []) {
          cardActions.push(archidekt.createAddCardAction({
            cardId: String(item.card.id),
            quantity: item.quantity,
            categories: item.categories || [],
            modifier: item.modifier || 'Normal',
          }));
        }
      }

      // Custom cards to add: resolve names against the user's custom-card library.
      if (addExtract.customLines.length > 0) {
        const library = await archidekt.listCustomCards(accessToken);
        for (const { name: cardName, quantity, category } of addExtract.customLines) {
          const match = library.find(cc => cc.frontName?.toLowerCase() === cardName.toLowerCase());
          if (match) {
            cardActions.push(archidekt.createAddCustomCardAction({
              customCardId: match.id,
              quantity,
              categories: category ? [category] : ['Custom Card'],
            }));
          } else {
            warnings.push(`No custom card named "${cardName}" in your library (create it first with create_custom_card)`);
          }
        }
      }

      // Real cards to remove: find them in the current deck by name.
      if (hasCardLines(removeExtract.remainingText)) {
        for (const rawLine of removeExtract.remainingText.split('\n')) {
          const line = rawLine.trim();
          if (!line || line.startsWith('#')) continue;

          // Parse line like "2 Sol Ring" or "1x Lightning Bolt"
          const match = line.match(/^(\d+)x?\s+(.+?)(?:\s+\([\w]+\))?(?:\s+\[.+\])?$/i);
          if (!match) continue;

          const qty = parseInt(match[1], 10);
          const cardName = match[2].trim();

          // Find this card in the current deck
          const deckCard = currentCards.find(c =>
            c.card.oracleCard.name.toLowerCase() === cardName.toLowerCase()
          );

          if (deckCard) {
            const currentQty = deckCard.quantity || 1;
            if (qty >= currentQty) {
              // Removing the whole stack: "remove" deletes the deck relation.
              cardActions.push(archidekt.createRemoveCardAction({
                cardId: String(deckCard.card.id),
                deckRelationId: String(deckCard.id),
                quantity: currentQty,
                categories: deckCard.categories || [],
                modifier: deckCard.modifier || 'Normal',
              }));
            } else {
              // Partial removal: "remove" would wipe the whole relation, so
              // "modify" the relation down to the remaining quantity instead.
              cardActions.push(archidekt.createModifyCardAction({
                cardId: String(deckCard.card.id),
                deckRelationId: String(deckCard.id),
                quantity: currentQty - qty,
                categories: deckCard.categories || [],
                modifier: deckCard.modifier || 'Normal',
              }));
            }
          } else {
            warnings.push(`Card not found in deck: ${cardName}`);
          }
        }
      }

      // Custom cards to remove: match against the deck's customCards array.
      if (removeExtract.customLines.length > 0) {
        const deckCustomCards = deck.customCards || [];
        for (const { name: cardName, quantity } of removeExtract.customLines) {
          const entry = deckCustomCards.find(c => c.card?.frontName?.toLowerCase() === cardName.toLowerCase());
          if (entry) {
            const currentQty = entry.quantity || 1;
            if (quantity >= currentQty) {
              // Removing the whole stack: "remove" deletes the deck relation.
              cardActions.push(archidekt.createRemoveCustomCardAction({
                customCardId: entry.card.id,
                deckRelationId: String(entry.id),
                quantity: currentQty,
                categories: entry.categories || [],
                modifier: entry.modifier || 'Normal',
              }));
            } else {
              // Partial removal: "modify" down to the remaining quantity so we
              // don't wipe the whole relation.
              cardActions.push(archidekt.createModifyCustomCardAction({
                customCardId: entry.card.id,
                deckRelationId: String(entry.id),
                quantity: currentQty - quantity,
                categories: entry.categories || [],
                modifier: entry.modifier || 'Normal',
              }));
            }
          } else {
            warnings.push(`Custom card not found in deck: ${cardName}`);
          }
        }
      }

      if (cardActions.length === 0) {
        let text = 'No valid card changes to make.';
        if (warnings.length > 0) {
          text += `\n\nWarnings:\n${warnings.map(w => `- ${w}`).join('\n')}`;
        }
        return {
          content: [{ type: 'text', text }],
        };
      }

      server.sendLoggingMessage({ level: 'info', data: `Applying ${cardActions.length} card changes...` });

      // Apply the changes
      const result = await archidekt.modifyCards(accessToken, deck_id, cardActions);

      // Fetch updated deck for card count and legality check
      const updatedDeck = await archidekt.getDeck(accessToken, deck_id);
      const totalCards =
        (updatedDeck.cards || []).reduce((sum, c) => sum + c.quantity, 0) +
        (updatedDeck.customCards || []).reduce((sum, c) => sum + c.quantity, 0);

      // Build summary
      const added = result.add?.length || 0;
      // "modify" actions here are always partial removals (stack reductions).
      const removed = cardActions.filter(a => a.action === 'remove' || a.action === 'modify').length;

      let summary = `Updated deck ${deck_id}:\n`;
      if (added > 0) summary += `- Added ${added} card(s)\n`;
      if (removed > 0) summary += `- Removed ${removed} card(s)\n`;
      summary += `- Total: ${totalCards} cards`;

      const allWarnings = [...warnings, ...(diffResult.cardErrors || [])];
      if (allWarnings.length > 0) {
        summary += `\n\nWarnings:\n${allWarnings.map(e => `- ${e}`).join('\n')}`;
      }

      // Check for newly introduced legality issues
      const issuesAfter = getLegalityIssues(updatedDeck.cards || [], updatedDeck.deckFormat);
      const newIssues = issuesAfter.filter(i => !issuesBefore.has(i));
      if (newIssues.length > 0) {
        summary += `\n\nLegality Issues Introduced:\n${newIssues.map(i => `- ${i}`).join('\n')}`;
      }

      return {
        content: [{ type: 'text', text: summary }],
      };
    } catch (error) {
      server.sendLoggingMessage({ level: 'error', data: `Update deck error: ${error.message}` });
      return {
        content: [{ type: 'text', text: `Failed to update deck: ${error.message}` }],
        isError: true,
      };
    }
  }

  // create_custom_card
  if (name === 'create_custom_card') {
    const facesError = validateFacesArg(args.faces);
    if (facesError) {
      return { content: [{ type: 'text', text: facesError }], isError: true };
    }

    try {
      const { accessToken, userId, username } = await archidekt.getAuth();

      const card = await renderAndBuildCard(accessToken, username, args);

      server.sendLoggingMessage({ level: 'info', data: `Creating custom card: ${card.frontName}` });
      const created = await archidekt.createCustomCard(accessToken, userId, card);

      // Remember it so edit_custom_card / delete_custom_card can touch it this session.
      if (created.id) sessionCustomCardIds.add(created.id);

      const output = `Created custom card "${created.frontName}" (ID: ${created.id})` + summarizeCustomCard(created);
      return {
        content: [{ type: 'text', text: output }],
      };
    } catch (error) {
      server.sendLoggingMessage({ level: 'error', data: `Create custom card error: ${error.message}` });
      return {
        content: [{ type: 'text', text: `Failed to create custom card: ${error.message}` }],
        isError: true,
      };
    }
  }

  // edit_custom_card
  if (name === 'edit_custom_card') {
    const cardId = args.custom_card_id;

    // Same session-scoped guard as delete: only cards made this session.
    if (!sessionCustomCardIds.has(cardId)) {
      return {
        content: [{ type: 'text', text: `Custom card ${cardId} was not created in this session, so it can't be edited here. Only cards made with create_custom_card during this session can be edited.` }],
        isError: true,
      };
    }

    const facesError = validateFacesArg(args.faces);
    if (facesError) {
      return { content: [{ type: 'text', text: facesError }], isError: true };
    }

    try {
      const { accessToken, username } = await archidekt.getAuth();

      const card = await renderAndBuildCard(accessToken, username, args);

      server.sendLoggingMessage({ level: 'info', data: `Updating custom card ${cardId}: ${card.frontName}` });
      const updated = await archidekt.updateCustomCard(accessToken, cardId, card);

      const output = `Updated custom card "${updated.frontName}" (ID: ${cardId})` + summarizeCustomCard(updated);
      return {
        content: [{ type: 'text', text: output }],
      };
    } catch (error) {
      server.sendLoggingMessage({ level: 'error', data: `Edit custom card error: ${error.message}` });
      return {
        content: [{ type: 'text', text: `Failed to edit custom card: ${error.message}` }],
        isError: true,
      };
    }
  }

  // list_custom_cards
  if (name === 'list_custom_cards') {
    try {
      const { accessToken } = await archidekt.getAuth();
      server.sendLoggingMessage({ level: 'info', data: 'Fetching custom cards...' });

      const cards = await archidekt.listCustomCards(accessToken);

      if (!cards || cards.length === 0) {
        return {
          content: [{ type: 'text', text: 'No custom cards found. Create one with create_custom_card.' }],
        };
      }

      let output = `Found ${cards.length} custom card(s). Reference one in update_deck as "Custom#<name>":\n\n`;
      for (const c of cards) {
        const typeLine = [c.frontSuperTypes, c.frontTypes].filter(Boolean).join(' ');
        const fullType = typeLine + (c.frontSubTypes ? ` — ${c.frontSubTypes}` : '');
        output += `**${c.frontName}**`;
        if (c.frontManaCost) output += ` · ${c.frontManaCost}`;
        if (fullType.trim()) output += ` · ${fullType}`;
        if (c.hasBack && c.backName) output += ` // ${c.backName}`;
        output += '\n';
      }

      return {
        content: [{ type: 'text', text: output.trim() }],
      };
    } catch (error) {
      server.sendLoggingMessage({ level: 'error', data: `List custom cards error: ${error.message}` });
      return {
        content: [{ type: 'text', text: `Failed to list custom cards: ${error.message}` }],
        isError: true,
      };
    }
  }

  // delete_custom_card
  if (name === 'delete_custom_card') {
    const cardId = args.custom_card_id;

    // Only allow deleting cards created earlier in this same session.
    if (!sessionCustomCardIds.has(cardId)) {
      return {
        content: [{ type: 'text', text: `Custom card ${cardId} was not created in this session, so it can't be deleted here. Only cards made with create_custom_card during this session can be deleted; remove others manually on Archidekt.` }],
        isError: true,
      };
    }

    try {
      const { accessToken } = await archidekt.getAuth();
      server.sendLoggingMessage({ level: 'info', data: `Deleting custom card ${cardId}...` });

      await archidekt.deleteCustomCard(accessToken, cardId);
      sessionCustomCardIds.delete(cardId);

      return {
        content: [{ type: 'text', text: `Deleted custom card ${cardId}.` }],
      };
    } catch (error) {
      server.sendLoggingMessage({ level: 'error', data: `Delete custom card error: ${error.message}` });
      return {
        content: [{ type: 'text', text: `Failed to delete custom card: ${error.message}` }],
        isError: true,
      };
    }
  }

  // lookup_cards
  if (name === 'lookup_cards') {
    const cardNamesInput = args.card_names;

    if (!cardNamesInput || !cardNamesInput.trim()) {
      return {
        content: [{ type: 'text', text: 'Please provide at least one card name.' }],
        isError: true,
      };
    }

    // Parse newline-separated list
    const cardNames = cardNamesInput.split('\n').map(l => l.trim()).filter(l => l);

    if (cardNames.length === 0) {
      return {
        content: [{ type: 'text', text: 'Please provide at least one card name.' }],
        isError: true,
      };
    }

    try {
      server.sendLoggingMessage({ level: 'info', data: `Looking up ${cardNames.length} card(s)...` });

      const { found, notFound } = await scryfall.lookupCollection(cardNames);

      if (found.length === 0) {
        return {
          content: [{ type: 'text', text: `No cards found for: ${cardNames.join(', ')}` }],
        };
      }

      // Format each card concisely
      let output = '';
      for (const card of found) {
        output += `## ${card.name}\n`;
        output += `${card.mana_cost || 'No mana cost'} · ${card.type_line}\n`;
        if (card.oracle_text) {
          output += `${card.oracle_text}\n`;
        }
        if (card.power && card.toughness) {
          output += `**${card.power}/${card.toughness}**\n`;
        }
        if (card.loyalty) {
          output += `Loyalty: ${card.loyalty}\n`;
        }
        output += '\n';
      }

      if (notFound.length > 0) {
        output += `---\nNot found: ${notFound.join(', ')}\n`;
      }

      return {
        content: [{ type: 'text', text: output.trim() }],
      };
    } catch (error) {
      server.sendLoggingMessage({ level: 'error', data: `Lookup cards error: ${error.message}` });
      return {
        content: [{ type: 'text', text: `Failed to look up cards: ${error.message}` }],
        isError: true,
      };
    }
  }

  // search_cards
  if (name === 'search_cards') {
    const { query, limit = 20, page = 1, order = 'name', include_text = false, format = 'commander' } = args;

    if (!query || !query.trim()) {
      return {
        content: [{ type: 'text', text: 'Please provide a search query.' }],
        isError: true,
      };
    }

    // Build full query with format filter
    let fullQuery = query.trim();
    if (format && format.toLowerCase() !== 'all') {
      fullQuery += ` format:${format}`;
    }

    const maxResults = Math.min(limit, 175);
    const offset = (page - 1) * maxResults;

    try {
      server.sendLoggingMessage({ level: 'info', data: `Searching: ${fullQuery} (page ${page}, offset ${offset}, order: ${order})` });

      const result = await scryfall.searchPaginated(fullQuery, { offset, limit: maxResults, order });

      if (!result.cards || result.cards.length === 0) {
        if (offset > 0) {
          return {
            content: [{ type: 'text', text: `No more results. Total: ${result.totalCards}` }],
          };
        }
        return {
          content: [{ type: 'text', text: `No cards found for query: ${fullQuery}` }],
        };
      }

      const cards = result.cards;
      const totalFound = result.totalCards;
      const startNum = offset + 1;
      const endNum = offset + cards.length;

      // Format results
      let output = `Found ${totalFound} card(s). Showing ${startNum}-${endNum}:\n\n`;

      for (const card of cards) {
        output += `**${card.name}** · ${card.mana_cost || 'No cost'} · ${card.type_line}\n`;
        if (include_text && card.oracle_text) {
          output += `${card.oracle_text}\n`;
        }
        if (include_text) {
          output += '\n';
        }
      }

      if (result.hasMore) {
        output += `\n---\nMore results available. Use page=${page + 1} to see next page.`;
      }

      return {
        content: [{ type: 'text', text: output.trim() }],
      };
    } catch (error) {
      server.sendLoggingMessage({ level: 'error', data: `Search cards error: ${error.message}` });
      return {
        content: [{ type: 'text', text: `Failed to search cards: ${error.message}` }],
        isError: true,
      };
    }
  }

  return {
    content: [{ type: 'text', text: `Unknown tool: ${name}` }],
    isError: true,
  };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Command Tower MCP Server running');
}

main().catch(console.error);
