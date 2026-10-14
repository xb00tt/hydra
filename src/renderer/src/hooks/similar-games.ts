import type { GameShop } from "@types";

export const SIMILAR_GAMES_LIMIT = 12;

// Broad Steam user tags that describe mode, mood, or rating rather than what
// a game is. Ids from /catalogue/steam/tags?language=en on 2026-10-14.
export const GENERIC_STEAM_TAG_IDS: ReadonlySet<number> = new Set([
  4182, // Singleplayer
  3859, // Multiplayer
  3843, // Online Co-Op
  1685, // Co-op
  492, // Indie
  19, // Action
  21, // Adventure
  597, // Casual
  599, // Simulation
  9, // Strategy
  122, // RPG
  113, // Free to Play
  493, // Early Access
  1756, // Great Soundtrack
  4166, // Atmospheric
  3871, // 2D
  4191, // 3D
  7481, // Controller
  4026, // Difficult
  4726, // Cute
  4305, // Colorful
  4136, // Funny
  1654, // Relaxing
  5350, // Family Friendly
  1693, // Classic
  1669, // Moddable
  4252, // Stylized
  4175, // Realistic
  4667, // Violent
  4345, // Gore
  5611, // Mature
  6650, // Nudity
  12095, // Sexual Content
]);

// Specific tags first, then generic ones; vote order kept inside each group.
export const orderTagsSpecificFirst = (tags: number[]) => [
  ...tags.filter((tag) => !GENERIC_STEAM_TAG_IDS.has(tag)),
  ...tags.filter((tag) => GENERIC_STEAM_TAG_IDS.has(tag)),
];

// Replaced by SIMILAR_GAMES_TAG_QUERIES in Task 3.
export const SIMILAR_GAMES_TAG_TIERS = [6, 5, 4];

export type SimilarGamesSectionState = "hidden" | "loading" | "ready" | "empty";

export const getSimilarGamesSectionState = (
  isEligible: boolean,
  isLoading: boolean,
  gameCount: number
): SimilarGamesSectionState => {
  if (!isEligible) return "hidden";
  if (isLoading) return "loading";
  if (gameCount > 0) return "ready";

  return "empty";
};

export interface SimilarGamesQuery {
  objectId: string;
  shop: GameShop;
}

export interface SimilarGame {
  objectId: string;
  shop: Exclude<GameShop, "custom">;
  title: string;
  iconUrl: string | null;
  libraryHeroImageUrl: string | null;
  libraryImageUrl: string | null;
  coverImageUrl: string | null;
  logoImageUrl: string | null;
  downloadSources: string[];
  // Tags of the narrowest query that returned this game; empty for /similar results.
  sharedTagIds: number[];
}

interface SimilarGamesGetOptions {
  params?: {
    take: number;
    downloadSourceIds: string[];
  };
  needsAuth: false;
}

interface SimilarGamesPostOptions {
  data: unknown;
  needsAuth: false;
}

export type SimilarGamesGet = (
  path: string,
  options: SimilarGamesGetOptions
) => Promise<unknown>;

export type SimilarGamesPost = (
  path: string,
  options: SimilarGamesPostOptions
) => Promise<unknown>;

export interface SimilarGamesApi {
  get: SimilarGamesGet;
  post: SimilarGamesPost;
}

const isSupportedShop = (
  shop: GameShop
): shop is Exclude<GameShop, "custom"> => {
  return shop === "steam" || shop === "launchbox";
};

const optionalString = (value: unknown) => {
  return typeof value === "string" ? value : null;
};

const normalizeDownloadSources = (value: unknown) => {
  if (!Array.isArray(value)) return [];

  return value.filter(
    (source): source is string =>
      typeof source === "string" && source.trim().length > 0
  );
};

const normalizeSimilarGame = (value: unknown): SimilarGame | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.objectId !== "string" ||
    (candidate.shop !== "steam" && candidate.shop !== "launchbox") ||
    typeof candidate.title !== "string"
  ) {
    return null;
  }

  const objectId = candidate.objectId.trim();
  const title = candidate.title.trim();

  if (!objectId || !title) return null;

  return {
    objectId,
    shop: candidate.shop,
    title,
    iconUrl: optionalString(candidate.iconUrl),
    libraryHeroImageUrl: optionalString(candidate.libraryHeroImageUrl),
    libraryImageUrl: optionalString(candidate.libraryImageUrl),
    coverImageUrl: optionalString(candidate.coverImageUrl),
    logoImageUrl: optionalString(candidate.logoImageUrl),
    downloadSources: normalizeDownloadSources(candidate.downloadSources),
    sharedTagIds: [],
  };
};

export const similarGameKey = (game: { shop: string; objectId: string }) =>
  `${game.shop}:${game.objectId}`;

const normalizeCandidates = (response: unknown, query: SimilarGamesQuery) => {
  if (!Array.isArray(response)) {
    throw new TypeError("Invalid similar games response");
  }

  return response.flatMap((candidate) => {
    const game = normalizeSimilarGame(candidate);

    return game && game.shop === query.shop && game.objectId !== query.objectId
      ? [game]
      : [];
  });
};

export const normalizeSimilarGamesResponse = (
  response: unknown,
  query: SimilarGamesQuery
) => {
  const seen = new Set<string>();

  return normalizeCandidates(response, query)
    .filter((game) => {
      const key = similarGameKey(game);

      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, SIMILAR_GAMES_LIMIT);
};

export interface TagQueryResult {
  tags: number[];
  edges: unknown[];
}

interface RankedCandidate {
  game: SimilarGame;
  hits: number;
  firstSeen: number;
}

// Tag results must arrive narrowest query first: the first query that returns
// a game decides its sharedTagIds and its firstSeen position.
export const rankSimilarGames = (
  tagResults: TagQueryResult[],
  similarResponse: unknown,
  query: SimilarGamesQuery
): SimilarGame[] => {
  const candidates = new Map<string, RankedCandidate>();

  const add = (game: SimilarGame, hit: boolean) => {
    const key = similarGameKey(game);
    const existing = candidates.get(key);

    if (existing) {
      if (hit) existing.hits += 1;
      return;
    }

    candidates.set(key, { game, hits: hit ? 1 : 0, firstSeen: candidates.size });
  };

  for (const { tags, edges } of tagResults) {
    const seenInQuery = new Set<string>();

    for (const game of normalizeCandidates(edges, query)) {
      const key = similarGameKey(game);

      if (seenInQuery.has(key)) continue;
      seenInQuery.add(key);
      add({ ...game, sharedTagIds: tags }, true);
    }
  }

  if (Array.isArray(similarResponse)) {
    for (const game of normalizeCandidates(similarResponse, query)) {
      add(game, false);
    }
  }

  return [...candidates.values()]
    .sort(
      (a, b) =>
        b.hits - a.hits ||
        Number(b.game.downloadSources.length > 0) -
          Number(a.game.downloadSources.length > 0) ||
        a.firstSeen - b.firstSeen
    )
    .map(({ game }) => game)
    .slice(0, SIMILAR_GAMES_LIMIT);
};

const steamCoverImageUrl = (objectId: string) =>
  `https://shared.steamstatic.com/store_item_assets/steam/apps/${objectId}/library_600x900_2x.jpg`;

const fetchGameTags = async (
  query: SimilarGamesQuery,
  get: SimilarGamesGet
) => {
  const response = await get(
    `/games/${query.shop}/${encodeURIComponent(query.objectId)}`,
    { needsAuth: false }
  );
  const tags = (response as { tags?: unknown } | null)?.tags;
  if (!Array.isArray(tags)) return [];

  return tags.map(Number).filter(Number.isInteger);
};

const searchByTags = async (
  tags: number[],
  post: SimilarGamesPost,
  downloadSourceIds: string[]
): Promise<unknown[]> => {
  const response = await post("/catalogue/search", {
    data: {
      take: SIMILAR_GAMES_LIMIT + 1,
      skip: 0,
      title: "",
      sortBy: "popularity",
      sortOrder: "desc",
      downloadSourceIds,
      downloadSourceFingerprints: [],
      tags,
      publishers: [],
      genres: [],
      developers: [],
      protondbSupportBadges: [],
      deckCompatibility: [],
    },
    needsAuth: false,
  });
  const edges = (response as { edges?: unknown } | null)?.edges;
  if (!Array.isArray(edges)) return [];

  return edges.map((edge) => {
    const candidate = edge as { objectId?: unknown; shop?: unknown } | null;
    if (typeof candidate?.objectId !== "string" || candidate.shop !== "steam") {
      return edge;
    }

    return {
      ...candidate,
      coverImageUrl: steamCoverImageUrl(candidate.objectId),
    };
  });
};

const fetchTagMatches = async (
  query: SimilarGamesQuery,
  api: SimilarGamesApi,
  downloadSourceIds: string[]
) => {
  try {
    const tags = await fetchGameTags(query, api.get);
    const tiers = SIMILAR_GAMES_TAG_TIERS.filter((size) => size <= tags.length);
    const results = await Promise.all(
      tiers.map((size) =>
        searchByTags(tags.slice(0, size), api.post, downloadSourceIds)
      )
    );

    return normalizeSimilarGamesResponse(results.flat(), query);
  } catch {
    return [];
  }
};

export const fetchSimilarGames = async (
  query: SimilarGamesQuery,
  api: SimilarGamesApi,
  downloadSourceIds: string[] = []
) => {
  if (!isSupportedShop(query.shop) || !query.objectId) return [];

  const tagMatches =
    query.shop === "steam"
      ? await fetchTagMatches(query, api, downloadSourceIds)
      : [];
  if (tagMatches.length >= SIMILAR_GAMES_LIMIT) return tagMatches;

  const response = await api.get(
    `/catalogue/${query.shop}/${encodeURIComponent(query.objectId)}/similar`,
    {
      params: { take: SIMILAR_GAMES_LIMIT, downloadSourceIds },
      needsAuth: false,
    }
  );

  return normalizeSimilarGamesResponse(
    [...tagMatches, ...normalizeSimilarGamesResponse(response, query)],
    query
  );
};
