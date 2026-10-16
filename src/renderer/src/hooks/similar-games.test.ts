import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, describe, it } from "node:test";

import {
  buildSimilarGameViews,
  clearSimilarGamesCache,
  fetchSimilarGames,
  getCachedSimilarGames,
  getSimilarGamesSectionState,
  normalizeSimilarGamesResponse,
  orderTagsSpecificFirst,
  rankSimilarGames,
  resolveSimilarGames,
  type SimilarGame,
  type SimilarGamesApi,
} from "./similar-games.js";

describe("getSimilarGamesSectionState", () => {
  it("uses the same hidden, loading, ready, and empty states on both surfaces", () => {
    assert.equal(getSimilarGamesSectionState(false, false, 0), "hidden");
    assert.equal(getSimilarGamesSectionState(true, true, 0), "loading");
    assert.equal(getSimilarGamesSectionState(true, false, 1), "ready");
    assert.equal(getSimilarGamesSectionState(true, false, 0), "empty");
  });
});

const game = (
  objectId: string,
  overrides: Partial<SimilarGame> = {}
): SimilarGame => ({
  objectId,
  shop: "steam",
  title: `Game ${objectId}`,
  iconUrl: null,
  libraryHeroImageUrl: null,
  libraryImageUrl: `https://example.com/${objectId}.jpg`,
  coverImageUrl: null,
  logoImageUrl: null,
  downloadSources: [],
  sharedTagIds: [],
  ...overrides,
});

describe("normalizeSimilarGamesResponse", () => {
  const query = { objectId: "current", shop: "steam" as const };

  it("preserves server order while excluding invalid identities and duplicates", () => {
    const results = normalizeSimilarGamesResponse(
      [
        game("first"),
        game("current"),
        game("other-shop", { shop: "launchbox" }),
        game("first"),
        game("second"),
      ],
      query
    );

    assert.deepEqual(
      results.map(({ objectId }) => objectId),
      ["first", "second"]
    );
  });

  it("rejects blank identities, trims valid identities, and preserves the limit", () => {
    const results = normalizeSimilarGamesResponse(
      [
        game(" \t "),
        game("blank-title", { title: " \t " }),
        game(" padded-id ", { title: " Padded title " }),
        ...Array.from({ length: 11 }, (_, index) => game(`valid-${index}`)),
      ],
      query
    );

    assert.equal(results.length, 12);
    assert.equal(results[0].objectId, "padded-id");
    assert.equal(results[0].title, "Padded title");
  });

  it("drops malformed download sources and limits results to twelve", () => {
    const response = Array.from({ length: 15 }, (_, index) => ({
      ...game(String(index)),
      downloadSources: [
        `Source ${index}`,
        { id: `source-${index}` },
        { name: "Legacy" },
        "",
      ],
    }));

    const results = normalizeSimilarGamesResponse(response, query);

    assert.equal(results.length, 12);
    assert.deepEqual(results[0].downloadSources, ["Source 0"]);
  });

  it("keeps API-resolved profile cover artwork", () => {
    const [result] = normalizeSimilarGamesResponse(
      [
        game("profile-cover", {
          coverImageUrl: "https://example.com/profile-cover.jpg",
        }),
      ],
      query
    );

    assert.equal(result.coverImageUrl, "https://example.com/profile-cover.jpg");
  });

  it("skips malformed games without rejecting usable results", () => {
    const results = normalizeSimilarGamesResponse(
      [
        null,
        { objectId: "broken", shop: "steam" },
        {
          ...game("missing-sources"),
          downloadSources: undefined,
        },
        game("valid"),
      ],
      query
    );

    assert.deepEqual(
      results.map(({ objectId }) => objectId),
      ["missing-sources", "valid"]
    );
    assert.deepEqual(results[0].downloadSources, []);
  });

  it("rejects malformed top-level endpoint responses", () => {
    assert.throws(() => normalizeSimilarGamesResponse({}, query), TypeError);
  });
});

const searchEdge = (objectId: string) => ({
  objectId,
  shop: "steam",
  title: `Game ${objectId}`,
  libraryImageUrl: `https://example.com/${objectId}.jpg`,
  downloadSources: ["Source"],
});

type SteamRecommendations = Awaited<
  ReturnType<SimilarGamesApi["getSteamRecommendations"]>
>;

interface ApiCall {
  method: "get" | "post" | "steamTags" | "steamRecommendations";
  path: string;
  options: unknown;
}

const createApi = (handlers: {
  search?: (tags: number[], sortBy: string) => unknown;
  similar?: unknown | (() => Promise<unknown>);
  steamTags?: number[] | (() => Promise<number[]>);
  recommendations?: SteamRecommendations;
}) => {
  const calls: ApiCall[] = [];
  const api: SimilarGamesApi = {
    get: async (path, options) => {
      calls.push({ method: "get", path, options });
      return typeof handlers.similar === "function"
        ? handlers.similar()
        : (handlers.similar ?? []);
    },
    post: async (path, options) => {
      calls.push({ method: "post", path, options });
      const { tags, sortBy } = options.data as {
        tags: number[];
        sortBy: string;
      };
      if (!handlers.search) throw new Error("unexpected search");
      return { edges: handlers.search(tags, sortBy), count: 0 };
    },
    getSteamTags: async (objectId) => {
      calls.push({ method: "steamTags", path: objectId, options: null });
      return typeof handlers.steamTags === "function"
        ? handlers.steamTags()
        : (handlers.steamTags ?? []);
    },
    getSteamRecommendations: async (objectId) => {
      calls.push({
        method: "steamRecommendations",
        path: objectId,
        options: null,
      });
      return handlers.recommendations ?? [];
    },
  };

  return { api, calls };
};

const searchCalls = (calls: ApiCall[]) =>
  calls
    .filter((call) => call.method === "post")
    .map((call) => {
      const { tags, sortBy, take } = (
        call.options as {
          data: { tags: number[]; sortBy: string; take: number };
        }
      ).data;
      return { tags, sortBy, take };
    });

const ids = (games: SimilarGame[]) => games.map(({ objectId }) => objectId);

describe("fetchSimilarGames: original", () => {
  const query = {
    objectId: "current",
    shop: "steam" as const,
    source: "original" as const,
  };

  beforeEach(() => clearSimilarGamesCache());

  it("uses only Hydra's similar endpoint", async () => {
    const { api, calls } = createApi({
      similar: [game("a"), game("current"), game("b")],
    });

    const results = await fetchSimilarGames(query, api, ["source-a"]);

    assert.deepEqual(ids(results), ["a", "b"]);
    assert.deepEqual(calls, [
      {
        method: "get",
        path: "/catalogue/steam/current/similar",
        options: {
          params: { take: 12, downloadSourceIds: ["source-a"] },
          needsAuth: false,
        },
      },
    ]);
  });

  it("works for launchbox games", async () => {
    const { api, calls } = createApi({
      similar: [game("result", { shop: "launchbox" })],
    });

    const results = await fetchSimilarGames(
      { objectId: "game/id", shop: "launchbox", source: "original" },
      api,
      ["source-b", "source-a"]
    );

    assert.equal(results.length, 1);
    assert.equal(calls[0].path, "/catalogue/launchbox/game%2Fid/similar");
  });

  it("does not request unsupported custom games", async () => {
    const { api, calls } = createApi({});

    const results = await fetchSimilarGames(
      { objectId: "custom", shop: "custom", source: "original" },
      api
    );

    assert.deepEqual(results, []);
    assert.equal(calls.length, 0);
  });
});

describe("fetchSimilarGames: revamped", () => {
  const query = {
    objectId: "current",
    shop: "steam" as const,
    source: "revamped" as const,
  };
  // 21 (Adventure) and 4166 (Atmospheric) are generic and move to the back.
  const tags = [21, 1698, 1719, 5923, 1738, 4166, 7];
  const ordered = [1698, 1719, 5923, 1738, 7, 21, 4166];

  beforeEach(() => clearSimilarGamesCache());

  it("runs six tag searches on the game's Steam store tags", async () => {
    const { api, calls } = createApi({
      steamTags: tags,
      search: (requested) => [searchEdge(`len-${requested.length}`)],
    });

    const results = await fetchSimilarGames(query, api, ["source-a"]);

    assert.deepEqual(searchCalls(calls), [
      { tags: ordered.slice(0, 6), sortBy: "popularity", take: 15 },
      { tags: ordered.slice(0, 5), sortBy: "popularity", take: 15 },
      { tags: ordered.slice(0, 5), sortBy: "reviewScore", take: 15 },
      { tags: ordered.slice(0, 4), sortBy: "popularity", take: 15 },
      { tags: ordered.slice(0, 3), sortBy: "popularity", take: 15 },
      { tags: ordered.slice(0, 2), sortBy: "popularity", take: 15 },
    ]);
    assert.equal(calls.filter((call) => call.method === "get").length, 0);
    assert.deepEqual(calls[1].options, {
      data: {
        take: 15,
        skip: 0,
        title: "",
        sortBy: "popularity",
        sortOrder: "desc",
        downloadSourceIds: ["source-a"],
        downloadSourceFingerprints: [],
        tags: ordered.slice(0, 6),
        publishers: [],
        genres: [],
        developers: [],
        protondbSupportBadges: [],
        deckCompatibility: [],
      },
      needsAuth: false,
    });
    // len-5 was returned by two queries, so it outranks the single-hit games.
    assert.deepEqual(ids(results), [
      "len-5",
      "len-6",
      "len-4",
      "len-3",
      "len-2",
    ]);
    assert.equal(
      results[1].coverImageUrl,
      "https://shared.steamstatic.com/store_item_assets/steam/apps/len-6/library_600x900_2x.jpg"
    );
    assert.deepEqual(results[1].sharedTagIds, ordered.slice(0, 6));
    assert.deepEqual(results[1].downloadSources, ["Source"]);
  });

  it("requests only the queries the game has enough tags for", async () => {
    const { api, calls } = createApi({
      steamTags: tags.slice(0, 4),
      search: () => [searchEdge("a")],
    });

    await fetchSimilarGames(query, api);

    assert.deepEqual(
      searchCalls(calls).map(({ tags, sortBy }) => [tags.length, sortBy]),
      [
        [4, "popularity"],
        [3, "popularity"],
        [2, "popularity"],
      ]
    );
  });

  it("drops tags the catalogue search never matches", async () => {
    // 1716 Roguelike and 3959 Roguelite return no catalogue results.
    const { api, calls } = createApi({
      steamTags: [1716, 1698, 3959, 1719],
      search: () => [searchEdge("a")],
    });

    await fetchSimilarGames(query, api);

    assert.deepEqual(
      searchCalls(calls).map(({ tags }) => tags),
      [[1698, 1719]]
    );
  });

  it("returns nothing when the game has fewer than two tags", async () => {
    const { api, calls } = createApi({ steamTags: [1698] });

    assert.deepEqual(await fetchSimilarGames(query, api), []);
    assert.equal(searchCalls(calls).length, 0);
  });

  it("returns nothing when the Steam tag lookup fails", async () => {
    const { api } = createApi({
      steamTags: () => Promise.reject(new Error("offline")),
    });

    assert.deepEqual(await fetchSimilarGames(query, api), []);
  });

  it("keeps the other searches when one tag search fails", async () => {
    const { api } = createApi({
      steamTags: tags,
      search: (requested) => {
        if (requested.length === 6) throw new Error("search down");
        return [searchEdge(`len-${requested.length}`)];
      },
    });

    const results = await fetchSimilarGames(query, api);

    assert.deepEqual(ids(results), ["len-5", "len-4", "len-3", "len-2"]);
  });

  it("is not available for launchbox games", async () => {
    const { api, calls } = createApi({});

    const results = await fetchSimilarGames(
      { objectId: "game", shop: "launchbox", source: "revamped" },
      api
    );

    assert.deepEqual(results, []);
    assert.equal(calls.length, 0);
  });

  it("returns cached results without calling the API again", async () => {
    const { api, calls } = createApi({
      steamTags: tags,
      search: () => [searchEdge("a")],
    });

    const first = await fetchSimilarGames(query, api);
    const callCount = calls.length;
    const second = await fetchSimilarGames(query, api);

    assert.equal(second, first);
    assert.equal(calls.length, callCount);
    assert.equal(getCachedSimilarGames(query), first);
  });

  it("caches each source separately", async () => {
    const { api } = createApi({
      steamTags: tags,
      search: () => [searchEdge("a")],
    });

    await fetchSimilarGames(query, api);

    assert.equal(
      getCachedSimilarGames({ ...query, source: "original" }),
      undefined
    );
  });

  it("does not cache empty results", async () => {
    const { api, calls } = createApi({ steamTags: tags, search: () => [] });

    await fetchSimilarGames(query, api);
    const callCount = calls.length;
    await fetchSimilarGames(query, api);

    assert.equal(calls.length, callCount * 2);
    assert.equal(getCachedSimilarGames(query), undefined);
  });

  it("evicts the oldest entry past fifty games", async () => {
    const { api } = createApi({
      steamTags: tags,
      search: () => [searchEdge("a")],
    });

    for (let index = 0; index < 51; index += 1) {
      await fetchSimilarGames({ ...query, objectId: `g-${index}` }, api);
    }

    assert.equal(
      getCachedSimilarGames({ ...query, objectId: "g-0" }),
      undefined
    );
    assert.ok(getCachedSimilarGames({ ...query, objectId: "g-1" }));
    assert.ok(getCachedSimilarGames({ ...query, objectId: "g-50" }));
  });
});

describe("fetchSimilarGames: steam", () => {
  const query = {
    objectId: "current",
    shop: "steam" as const,
    source: "steam" as const,
  };
  const recommendation = (objectId: string, tagIds: number[] = []) => ({
    objectId,
    title: `Game ${objectId}`,
    tagIds,
    coverImageUrl: `https://example.com/${objectId}-cover.jpg`,
    libraryImageUrl: `https://example.com/${objectId}-header.jpg`,
  });

  beforeEach(() => clearSimilarGamesCache());

  it("lists Steam's recommendations in Steam's order, skipping the game itself", async () => {
    const { api, calls } = createApi({
      steamTags: [21, 1698],
      recommendations: [
        recommendation("b"),
        recommendation("current"),
        recommendation("a"),
      ],
    });

    const results = await fetchSimilarGames(query, api);

    assert.deepEqual(ids(results), ["b", "a"]);
    assert.deepEqual(results[0], {
      objectId: "b",
      shop: "steam",
      title: "Game b",
      iconUrl: null,
      libraryHeroImageUrl: null,
      libraryImageUrl: "https://example.com/b-header.jpg",
      coverImageUrl: "https://example.com/b-cover.jpg",
      logoImageUrl: null,
      downloadSources: [],
      sharedTagIds: [],
    });
    assert.equal(calls.filter((call) => call.method === "get").length, 0);
  });

  it("shares tags in the current game's specific-first order", async () => {
    // 21 Adventure is generic, so it follows the specific shared tags.
    const { api } = createApi({
      steamTags: [21, 1716, 1698, 1719],
      recommendations: [recommendation("a", [1719, 21, 99, 1716])],
    });

    const [result] = await fetchSimilarGames(query, api);

    assert.deepEqual(result.sharedTagIds, [1716, 1719, 21]);
  });

  it("caps the list at twelve", async () => {
    const { api } = createApi({
      recommendations: Array.from({ length: 15 }, (_, index) =>
        recommendation(`r-${index}`)
      ),
    });

    assert.equal((await fetchSimilarGames(query, api)).length, 12);
  });

  it("is not available for launchbox games", async () => {
    const { api, calls } = createApi({});

    const results = await fetchSimilarGames(
      { objectId: "game", shop: "launchbox", source: "steam" },
      api
    );

    assert.deepEqual(results, []);
    assert.equal(calls.length, 0);
  });
});

describe("orderTagsSpecificFirst", () => {
  it("moves generic tags behind specific ones, keeping vote order in each group", () => {
    // 122 RPG and 4182 Singleplayer are generic; 4747, 1695, 1684 are specific.
    assert.deepEqual(
      orderTagsSpecificFirst([122, 4747, 1695, 4182, 1684]),
      [4747, 1695, 1684, 122, 4182]
    );
  });

  it("returns tags unchanged when none are generic", () => {
    assert.deepEqual(orderTagsSpecificFirst([1698, 5613]), [1698, 5613]);
  });

  it("returns tags unchanged when all are generic", () => {
    assert.deepEqual(
      orderTagsSpecificFirst([4182, 492, 19, 21]),
      [4182, 492, 19, 21]
    );
  });
});

describe("rankSimilarGames", () => {
  const query = { objectId: "current", shop: "steam" as const };

  it("ranks games by how many queries returned them", () => {
    const results = rankSimilarGames(
      [
        { tags: [1, 2, 3, 4, 5, 6], edges: [searchEdge("a")] },
        { tags: [1, 2, 3, 4, 5], edges: [searchEdge("a"), searchEdge("b")] },
        {
          tags: [1, 2, 3, 4],
          edges: [searchEdge("c"), searchEdge("a"), searchEdge("b")],
        },
      ],
      query
    );

    assert.deepEqual(ids(results), ["a", "b", "c"]);
  });

  it("records the narrowest query's tags as shared tags", () => {
    const [a, b] = rankSimilarGames(
      [
        { tags: [1, 2, 3, 4, 5, 6], edges: [searchEdge("a")] },
        { tags: [1, 2, 3, 4], edges: [searchEdge("a"), searchEdge("b")] },
      ],
      query
    );

    assert.deepEqual(a.sharedTagIds, [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(b.sharedTagIds, [1, 2, 3, 4]);
  });

  it("prefers games with download sources when hits tie", () => {
    const results = rankSimilarGames(
      [
        {
          tags: [1, 2, 3, 4],
          edges: [
            { ...searchEdge("no-source"), downloadSources: [] },
            searchEdge("with-source"),
          ],
        },
      ],
      query
    );

    assert.deepEqual(ids(results), ["with-source", "no-source"]);
  });

  it("counts a game repeated inside one response as a single hit", () => {
    const results = rankSimilarGames(
      [
        {
          tags: [1, 2, 3, 4, 5],
          edges: [searchEdge("twice"), searchEdge("twice"), searchEdge("once")],
        },
        { tags: [1, 2, 3, 4], edges: [searchEdge("once")] },
      ],
      query
    );

    assert.deepEqual(ids(results), ["once", "twice"]);
  });

  it("drops the current game and caps at twelve", () => {
    const edges = Array.from({ length: 14 }, (_, index) =>
      searchEdge(`t-${index}`)
    );
    const results = rankSimilarGames(
      [{ tags: [1, 2, 3, 4], edges: [searchEdge("current"), ...edges] }],
      query
    );

    assert.equal(results.length, 12);
    assert.ok(results.every(({ objectId }) => objectId !== "current"));
  });
});

describe("buildSimilarGameViews", () => {
  const names = new Map([
    [1698, "Point & Click"],
    [5613, "Detective"],
    [3964, "Pixel Graphics"],
  ]);

  it("resolves up to two shared tag names, skipping unknown ids", () => {
    const [view] = buildSimilarGameViews(
      [game("a", { sharedTagIds: [999, 1698, 5613, 3964] })],
      new Set(),
      names
    );

    assert.deepEqual(view.sharedTags, ["Point & Click", "Detective"]);
    assert.equal(view.inLibrary, false);
  });

  it("marks owned games and moves them after unowned ones, keeping order otherwise", () => {
    const views = buildSimilarGameViews(
      [game("owned-1"), game("free-1"), game("owned-2"), game("free-2")],
      new Set(["steam:owned-1", "steam:owned-2"]),
      names
    );

    assert.deepEqual(
      views.map(({ objectId, inLibrary }) => [objectId, inLibrary]),
      [
        ["free-1", false],
        ["free-2", false],
        ["owned-1", true],
        ["owned-2", true],
      ]
    );
  });

  it("does not treat a same-id game from another shop as owned", () => {
    const [view] = buildSimilarGameViews(
      [game("a")],
      new Set(["custom:a", "launchbox:a"]),
      names
    );

    assert.equal(view.inLibrary, false);
  });

  it("leaves captions empty when no names are known", () => {
    const [view] = buildSimilarGameViews(
      [game("a", { sharedTagIds: [1698] })],
      new Set(),
      new Map()
    );

    assert.deepEqual(view.sharedTags, []);
  });
});

describe("resolveSimilarGames", () => {
  it("prefers a populated cache over stale empty state", () => {
    const cached = [game("cached")];

    assert.equal(resolveSimilarGames(cached, false, []), cached);
    assert.equal(resolveSimilarGames(cached, true, []), cached);
  });

  it("falls back to current state, or nothing, without a cache", () => {
    const current = [game("current")];

    assert.equal(resolveSimilarGames(undefined, true, current), current);
    assert.deepEqual(resolveSimilarGames(undefined, false, current), []);
  });
});

describe("useSimilarGames module", () => {
  it("stays redux-free because Big Picture mounts it without a Provider", () => {
    const source = readFileSync(
      new URL("./use-similar-games.ts", import.meta.url),
      "utf8"
    );

    for (const forbidden of [
      "./redux",
      "react-redux",
      "./use-library",
      "./use-catalogue",
      "@renderer/features",
    ]) {
      assert.ok(
        !source.includes(forbidden),
        `use-similar-games.ts must not import ${forbidden}`
      );
    }
  });
});
