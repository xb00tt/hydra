import type { GameShop } from "@types";

export const SIMILAR_GAMES_LIMIT = 9;
// Steam user tags are ordered by votes; AND-match the top N, narrowest first.
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
  };
};

export const normalizeSimilarGamesResponse = (
  response: unknown,
  query: SimilarGamesQuery
) => {
  if (!Array.isArray(response)) {
    throw new TypeError("Invalid similar games response");
  }

  const seen = new Set<string>();

  return response
    .flatMap((candidate) => {
      const game = normalizeSimilarGame(candidate);

      return game ? [game] : [];
    })
    .filter((game) => {
      const key = `${game.shop}:${game.objectId}`;
      const isValid =
        game.shop === query.shop && game.objectId !== query.objectId;

      if (!isValid || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
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
