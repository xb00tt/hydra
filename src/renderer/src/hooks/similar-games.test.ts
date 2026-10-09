import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  fetchSimilarGames,
  getSimilarGamesSectionState,
  normalizeSimilarGamesResponse,
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
        ...Array.from({ length: 8 }, (_, index) => game(`valid-${index}`)),
      ],
      query
    );

    assert.equal(results.length, 9);
    assert.equal(results[0].objectId, "padded-id");
    assert.equal(results[0].title, "Padded title");
  });

  it("drops malformed download sources and limits results to nine", () => {
    const response = Array.from({ length: 12 }, (_, index) => ({
      ...game(String(index)),
      downloadSources: [
        `Source ${index}`,
        { id: `source-${index}` },
        { name: "Legacy" },
        "",
      ],
    }));

    const results = normalizeSimilarGamesResponse(response, query);

    assert.equal(results.length, 9);
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

interface ApiCall {
  method: "get" | "post";
  path: string;
  options: unknown;
}

const createApi = (handlers: {
  tags?: unknown | (() => Promise<unknown>);
  search?: (tags: number[]) => unknown;
  similar?: unknown;
}) => {
  const calls: ApiCall[] = [];
  const api: SimilarGamesApi = {
    get: async (path, options) => {
      calls.push({ method: "get", path, options });
      if (path.startsWith("/games/")) {
        return typeof handlers.tags === "function"
          ? handlers.tags()
          : handlers.tags;
      }
      return handlers.similar ?? [];
    },
    post: async (path, options) => {
      calls.push({ method: "post", path, options });
      const { tags } = options.data as { tags: number[] };
      if (!handlers.search) throw new Error("unexpected search");
      return { edges: handlers.search(tags), count: 0 };
    },
  };

  return { api, calls };
};

const paths = (calls: ApiCall[]) => calls.map((call) => call.path);

describe("fetchSimilarGames", () => {
  const steamQuery = { objectId: "current", shop: "steam" as const };
  const tags = ["21", "1698", "1719", "5923", "1738", "4166", "7"];

  it("builds steam results from tag searches, narrowest tier first", async () => {
    const { api, calls } = createApi({
      tags: { tags },
      search: (requested) => {
        if (requested.length === 6) {
          return [searchEdge("current"), searchEdge("a"), searchEdge("b")];
        }
        if (requested.length === 5) return [searchEdge("b"), searchEdge("c")];
        return Array.from({ length: 10 }, (_, index) =>
          searchEdge(`wide-${index}`)
        );
      },
    });

    const results = await fetchSimilarGames(steamQuery, api, ["source-a"]);

    assert.deepEqual(
      results.map(({ objectId }) => objectId),
      [
        "a",
        "b",
        "c",
        "wide-0",
        "wide-1",
        "wide-2",
        "wide-3",
        "wide-4",
        "wide-5",
      ]
    );
    assert.equal(
      results[0].coverImageUrl,
      "https://shared.steamstatic.com/store_item_assets/steam/apps/a/library_600x900_2x.jpg"
    );
    assert.equal(results[0].libraryImageUrl, "https://example.com/a.jpg");
    assert.deepEqual(results[0].downloadSources, ["Source"]);

    assert.deepEqual(paths(calls), [
      "/games/steam/current",
      "/catalogue/search",
      "/catalogue/search",
      "/catalogue/search",
    ]);
    assert.deepEqual(calls[0].options, { needsAuth: false });
    assert.deepEqual(calls[1].options, {
      data: {
        take: 10,
        skip: 0,
        title: "",
        sortBy: "popularity",
        sortOrder: "desc",
        downloadSourceIds: ["source-a"],
        downloadSourceFingerprints: [],
        tags: [21, 1698, 1719, 5923, 1738, 4166],
        publishers: [],
        genres: [],
        developers: [],
        protondbSupportBadges: [],
        deckCompatibility: [],
      },
      needsAuth: false,
    });
    assert.deepEqual(
      calls
        .slice(1)
        .map(
          (call) => (call.options as { data: { tags: number[] } }).data.tags
        ),
      [
        [21, 1698, 1719, 5923, 1738, 4166],
        [21, 1698, 1719, 5923, 1738],
        [21, 1698, 1719, 5923],
      ]
    );
  });

  it("requests only the tiers the game has enough tags for", async () => {
    const { api, calls } = createApi({
      tags: { tags: tags.slice(0, 5) },
      search: () =>
        Array.from({ length: 10 }, (_, index) => searchEdge(`${index}`)),
    });

    await fetchSimilarGames(steamQuery, api);

    assert.deepEqual(
      calls
        .slice(1)
        .map(
          (call) => (call.options as { data: { tags: number[] } }).data.tags
        ),
      [
        [21, 1698, 1719, 5923, 1738],
        [21, 1698, 1719, 5923],
      ]
    );
  });

  it("fills remaining slots from the similar endpoint", async () => {
    const { api, calls } = createApi({
      tags: { tags },
      search: () => [searchEdge("a")],
      similar: [
        game("a"),
        ...Array.from({ length: 9 }, (_, index) => game(`similar-${index}`)),
      ],
    });

    const results = await fetchSimilarGames(steamQuery, api, ["source-a"]);

    assert.deepEqual(
      results.map(({ objectId }) => objectId),
      ["a", ...Array.from({ length: 8 }, (_, index) => `similar-${index}`)]
    );
    assert.deepEqual(calls.at(-1), {
      method: "get",
      path: "/catalogue/steam/current/similar",
      options: {
        params: { take: 9, downloadSourceIds: ["source-a"] },
        needsAuth: false,
      },
    });
  });

  it("uses the similar endpoint alone when the game has fewer than four tags", async () => {
    const { api, calls } = createApi({
      tags: { tags: ["21", "1698", "1719"] },
      similar: [game("fallback")],
    });

    const results = await fetchSimilarGames(steamQuery, api);

    assert.deepEqual(
      results.map(({ objectId }) => objectId),
      ["fallback"]
    );
    assert.deepEqual(paths(calls), [
      "/games/steam/current",
      "/catalogue/steam/current/similar",
    ]);
  });

  it("uses the similar endpoint alone when the tag lookup fails", async () => {
    const { api, calls } = createApi({
      tags: () => Promise.reject(new Error("offline")),
      similar: [game("fallback")],
    });

    const results = await fetchSimilarGames(steamQuery, api);

    assert.deepEqual(
      results.map(({ objectId }) => objectId),
      ["fallback"]
    );
    assert.equal(calls.filter((call) => call.method === "post").length, 0);
  });

  it("uses the similar endpoint alone when a tag search fails", async () => {
    const { api } = createApi({
      tags: { tags },
      search: () => {
        throw new Error("search down");
      },
      similar: [game("fallback")],
    });

    const results = await fetchSimilarGames(steamQuery, api);

    assert.deepEqual(
      results.map(({ objectId }) => objectId),
      ["fallback"]
    );
  });

  it("uses the similar endpoint alone for launchbox games", async () => {
    const { api, calls } = createApi({
      similar: [game("result", { shop: "launchbox" })],
    });

    const results = await fetchSimilarGames(
      { objectId: "game/id", shop: "launchbox" },
      api,
      ["source-b", "source-a"]
    );

    assert.equal(results.length, 1);
    assert.deepEqual(calls, [
      {
        method: "get",
        path: "/catalogue/launchbox/game%2Fid/similar",
        options: {
          params: { take: 9, downloadSourceIds: ["source-b", "source-a"] },
          needsAuth: false,
        },
      },
    ]);
  });

  it("does not request unsupported custom games", async () => {
    const { api, calls } = createApi({});

    const results = await fetchSimilarGames(
      { objectId: "custom", shop: "custom" },
      api
    );

    assert.deepEqual(results, []);
    assert.equal(calls.length, 0);
  });
});
