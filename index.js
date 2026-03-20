#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'gaming-deals', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// ==================== CACHES ====================
let _gamePassCache = null;
let _gamePassLoadPromise = null;

// ==================== UTILITIES ====================
function fuzzyMatch(haystack, needle) {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

async function fetchJSON(url, options = {}) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; gaming-mcp/1.0)',
      'Accept': 'application/json',
      ...options.headers,
    },
    ...options,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).hostname}`);
  return res.json();
}

// ==================== STEAM ====================

// Confirmed via ajaxgetdeckappcompatibilityreport: 0=Unknown, 1=Unsupported, 2=Playable, 3=Verified
const DECK_CATEGORIES = { 0: 'Unknown', 1: 'Unsupported', 2: 'Playable', 3: 'Verified' };

async function getDeckCompatibility(appid) {
  try {
    const data = await fetchJSON(
      `https://store.steampowered.com/saleaction/ajaxgetdeckappcompatibilityreport?nAppID=${appid}`
    );
    const category = data?.results?.resolved_category;
    return DECK_CATEGORIES[category] ?? 'Unknown';
  } catch {
    return 'Unknown';
  }
}

async function searchSteam(query) {
  const data = await fetchJSON(
    `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(query)}&l=english&cc=US`
  );

  const items = (data.items ?? []).slice(0, 5);

  // Fetch deck compatibility for all results in parallel
  const deckResults = await Promise.all(items.map(item => getDeckCompatibility(item.id)));

  return items.map((item, i) => {
    const price = item.price;
    // The storesearch API doesn't include discount_percent — compare initial vs final instead
    const onSale = price ? price.initial > price.final : false;
    const discountPct = onSale ? Math.round((1 - price.final / price.initial) * 100) : 0;
    return {
      name: item.name,
      appid: item.id,
      onSale,
      discount: onSale ? `${discountPct}% off` : null,
      currentPrice: price ? `$${(price.final / 100).toFixed(2)}` : 'Free or N/A',
      originalPrice: onSale ? `$${(price.initial / 100).toFixed(2)}` : null,
      steamDeck: deckResults[i],
      macOS: item.platforms?.mac ?? false,
      url: `https://store.steampowered.com/app/${item.id}`,
    };
  });
}

async function getSteamDeals({ count = 15, maxPrice = 60 } = {}) {
  // CheapShark aggregates Steam deals reliably, free, no auth needed
  const deals = await fetchJSON(
    `https://www.cheapshark.com/api/1.0/deals?storeID=1&pageSize=${count}&sortBy=Savings&desc=1&upperPrice=${maxPrice}`
  );

  return deals.map(deal => ({
    name: deal.title,
    salePrice: `$${deal.salePrice}`,
    normalPrice: `$${deal.normalPrice}`,
    savings: `${Math.round(parseFloat(deal.savings))}%`,
    metacriticScore: deal.metacriticScore > 0 ? Number(deal.metacriticScore) : null,
    steamLink: deal.steamAppID ? `https://store.steampowered.com/app/${deal.steamAppID}` : null,
  }));
}

// ==================== GAME PASS ====================

// Game Pass catalog SIGL ID — "All games" list (PC + console), verified working
const GAME_PASS_SIGL_ID = '29a81209-df6f-41fd-a528-2ae6b91f719c';

async function loadGamePassCatalog() {
  if (_gamePassCache) return _gamePassCache;
  if (_gamePassLoadPromise) return _gamePassLoadPromise;

  _gamePassLoadPromise = (async () => {
    // Step 1: Get all product IDs from the live Game Pass catalog
    const siglData = await fetchJSON(
      `https://catalog.gamepass.com/sigls/v2?id=${GAME_PASS_SIGL_ID}&language=en-us&market=US`
    );

    const ids = siglData
      .filter(item => item.id && typeof item.id === 'string')
      .map(item => item.id);

    if (ids.length === 0) throw new Error('Game Pass catalog returned no IDs');

    // Step 2: Batch-fetch game names from Microsoft's display catalog
    // 20 IDs per request, 4 concurrent batches
    const BATCH_SIZE = 20;
    const CONCURRENCY = 4;
    const games = [];

    for (let i = 0; i < ids.length; i += BATCH_SIZE * CONCURRENCY) {
      const batchPromises = [];
      for (let j = 0; j < CONCURRENCY; j++) {
        const start = i + j * BATCH_SIZE;
        if (start >= ids.length) break;
        const batch = ids.slice(start, start + BATCH_SIZE);
        batchPromises.push(
          fetchJSON(
            `https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=${batch.join(',')}&market=US&languages=en-us`
          ).then(data =>
            (data.Products ?? []).map(p => ({
              id: p.ProductId,
              name: p.LocalizedProperties?.[0]?.ProductTitle ?? 'Unknown',
            }))
          ).catch(() => []) // skip failed batches gracefully
        );
      }
      const results = await Promise.all(batchPromises);
      games.push(...results.flat());
      // Small pause between rounds to avoid rate limiting
      if (i + BATCH_SIZE * CONCURRENCY < ids.length) {
        await new Promise(r => setTimeout(r, 150));
      }
    }

    _gamePassCache = games;
    return games;
  })();

  return _gamePassLoadPromise;
}

async function checkGamePass(gameName) {
  const games = await loadGamePassCatalog();
  const matches = games.filter(g => fuzzyMatch(g.name, gameName));
  return {
    query: gameName,
    found: matches.length > 0,
    matches: matches.slice(0, 5).map(g => g.name),
    catalogSize: games.length,
  };
}

// ==================== GEFORCE NOW ====================
// Live search via the real API used by nvidia.com/en-us/geforce-now/games/
// No auth required — discovered by intercepting browser network requests.
const GFN_API_URL = 'https://api-prod.nvidia.com/services/gfngames/v1/gameList';
const GFN_VPC_ID = 'NP-DAL-04'; // US region ID

function buildGfnQuery(searchQuery) {
  return `{ apps(country:"US" language:"en_US" orderBy:"itemMetadata.relevance:DESC,sortName:ASC" after:"" searchQuery:${JSON.stringify(searchQuery)} vpcId:${JSON.stringify(GFN_VPC_ID)}) {
    numberReturned
    pageInfo { endCursor hasNextPage }
    items {
      title
      sortName
      gfn { playType minimumMembershipTierLabel }
      variants { appStore publisherName }
    }
  }}`;
}

async function searchGeForceNow(gameName) {
  const res = await fetch(GFN_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: buildGfnQuery(gameName),
  });
  if (!res.ok) throw new Error(`GFN API HTTP ${res.status}`);
  const data = await res.json();
  return data?.data?.apps?.items ?? [];
}

async function checkGeForceNow(gameName) {
  const items = await searchGeForceNow(gameName);
  return {
    query: gameName,
    found: items.length > 0,
    matches: items.slice(0, 5).map(g => ({
      title: g.title,
      playType: g.gfn?.playType ?? null,
      stores: g.variants?.map(v => v.appStore) ?? [],
    })),
  };
}

// ==================== UNIFIED CHECK ====================

async function checkGameEverywhere(gameName) {
  // Load Steam results + Game Pass catalog + GFN search all in parallel
  const [steamRes, gpCatalogRes, gfnRes] = await Promise.allSettled([
    searchSteam(gameName),
    loadGamePassCatalog(),
    searchGeForceNow(gameName),
  ]);

  const steamResults = steamRes.status === 'fulfilled' ? steamRes.value : [];
  const gpCatalog = gpCatalogRes.status === 'fulfilled' ? gpCatalogRes.value : null;
  const gfnItems = gfnRes.status === 'fulfilled' ? gfnRes.value : null;

  // Build a Set of GFN titles (lowercased) for fast matching against Steam results
  const gfnTitleSet = gfnItems
    ? new Set(gfnItems.map(g => g.title.toLowerCase()))
    : null;

  // For each Steam result, check Game Pass and GeForce Now
  const games = steamResults.map(game => {
    const gpMatch = gpCatalog
      ? gpCatalog.filter(g => fuzzyMatch(g.name, game.name))
      : null;

    // GFN: match the live search results against this Steam title
    const onGeForceNow = gfnTitleSet === null
      ? null
      : gfnTitleSet.has(game.name.toLowerCase()) ||
        gfnItems.some(g => fuzzyMatch(g.title, game.name) || fuzzyMatch(game.name, g.title));

    return {
      name: game.name,
      steamPrice: game.currentPrice,
      steamDiscount: game.discount,
      onSale: game.onSale,
      originalPrice: game.originalPrice,
      gamePass: gpMatch === null ? 'unknown' : gpMatch.length > 0 ? 'yes' : 'no',
      geforceNow: onGeForceNow === null ? 'unknown' : onGeForceNow ? 'yes' : 'no',
      steamDeck: game.steamDeck,
      macOS: game.macOS,
      url: game.url,
    };
  });

  const anyOnGamePass = games.some(g => g.gamePass === 'yes');
  const catalogErrors = {
    gamePass: gpCatalogRes.status === 'rejected' ? gpCatalogRes.reason?.message : null,
    geforceNow: gfnRes.status === 'rejected' ? gfnRes.reason?.message : null,
  };

  return {
    query: gameName,
    note: anyOnGamePass ? 'One or more versions are on Game Pass — check before buying!' : null,
    games,
    errors: Object.values(catalogErrors).some(Boolean) ? catalogErrors : undefined,
  };
}

// ==================== MCP HANDLERS ====================

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'search_steam',
      description: 'Search for a game on Steam. Returns current price, active discount, and store link.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Game name to search for on Steam' },
        },
        required: ['query'],
      },
    },
    {
      name: 'get_steam_deals',
      description: 'Get the best current Steam deals sorted by discount percentage.',
      inputSchema: {
        type: 'object',
        properties: {
          count: { type: 'number', description: 'Number of deals to return (default: 15, max: 60)' },
          max_price: { type: 'number', description: 'Max original price in USD to include (default: 60)' },
        },
      },
    },
    {
      name: 'check_game_pass',
      description: 'Check if a game is in the Xbox PC Game Pass catalog. Fetches the live catalog on first call (may take 10-20s); subsequent calls are instant.',
      inputSchema: {
        type: 'object',
        properties: {
          game: { type: 'string', description: 'Game name to search for in Game Pass' },
        },
        required: ['game'],
      },
    },
    {
      name: 'check_geforce_now',
      description: 'Check if a game is supported on NVIDIA GeForce Now cloud gaming.',
      inputSchema: {
        type: 'object',
        properties: {
          game: { type: 'string', description: 'Game name to check on GeForce Now' },
        },
        required: ['game'],
      },
    },
    {
      name: 'check_game_everywhere',
      description: 'One-shot check covering all Steam results for a query: Game Pass availability, GeForce Now support, Steam Deck rating, macOS support, and current Steam price/discount. Use this any time the user asks about buying, playing, or checking a game across platforms.',
      inputSchema: {
        type: 'object',
        properties: {
          game: { type: 'string', description: 'Game name to check across Steam, Game Pass, and GeForce Now' },
        },
        required: ['game'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result;
    switch (name) {
      case 'search_steam':
        result = await searchSteam(args.query);
        break;
      case 'get_steam_deals':
        result = await getSteamDeals({ count: args.count, maxPrice: args.max_price });
        break;
      case 'check_game_pass':
        result = await checkGamePass(args.game);
        break;
      case 'check_geforce_now':
        result = await checkGeForceNow(args.game);
        break;
      case 'check_game_everywhere':
        result = await checkGameEverywhere(args.game);
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);

// Pre-warm Game Pass catalog in background so first query is faster
loadGamePassCatalog().catch(() => {});
