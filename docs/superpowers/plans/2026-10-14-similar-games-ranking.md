# "More like this" Ranking and UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rank "More like this" by discriminating Steam tags with hit-count scoring, show shared tags and ownership on each card, and make the section load in one parallel round trip with a session cache.

**Architecture:** All logic stays in the renderer. `similar-games.ts` holds pure, testable functions (tag ordering, ranking, cache, view building). `use-similar-games.ts` wires them to the Hydra API, redux (library, tag names), and i18n. `similar-games.tsx` renders captions and badges. No backend or main-process changes.

**Tech Stack:** TypeScript, React 18, Redux Toolkit, react-i18next, SCSS, node:test runner via `yarn test`, electron-vite build.

**Spec:** `docs/superpowers/specs/2026-10-14-similar-games-ranking-design.md`

## Global Constraints

- `SIMILAR_GAMES_LIMIT = 12`; `/catalogue/search` `take` is 15 (endpoint rejects values below 5); `/similar` `take` is 12.
- Tag queries, in processing order (narrowest first, stable): size 6 popularity, size 5 popularity, size 5 reviewScore, size 4 popularity.
- Generic tag id set is exactly the 33 ids listed in the spec table.
- Sort inside `rankSimilarGames`: hits desc, has download sources desc, first-seen asc. Ownership sort happens only in `buildSimilarGameViews`.
- Cache: module-level `Map`, 50 entries, keyed `shop:objectId`, only non-empty results cached.
- Badge text uses the existing `game_details.already_in_library` key. No locale file edits.
- LaunchBox path: `/similar` only, as today. `custom` shop: nothing fetched.
- Code style: prettier (`semi`, double quotes, trailing commas es5), eslint via `yarn lint`.
- Run tests with: `node --import ./scripts/register-ts-node.mjs --test src/renderer/src/hooks/similar-games.test.ts`

## Review Focus

1. A game whose top tags are all generic (Singleplayer, Indie, Action, Adventure) must still produce queries and results; `orderTagsSpecificFirst` returns the same order. Pinned in Task 1.
2. `/games/steam/{id}` returning non-numeric tag strings must not break tiering; invalid ids are dropped before partitioning. Pinned in Task 3.
3. A library entry from another shop with the same `objectId` (for example a `custom` game) must not mark the Steam game as owned. Pinned in Task 5.
4. The same game repeated inside one search response must count as one hit, not two. Pinned in Task 2.
5. Navigating back to a game after the library changed must show the new ownership without a refetch; the cache stores no ownership. Pinned in Task 5 (pure function) and verified manually in Task 8.

---

### Task 1: Tag ordering and new limit

**Files:**
- Modify: `src/renderer/src/hooks/similar-games.ts:3-5`
- Test: `src/renderer/src/hooks/similar-games.test.ts`

**Interfaces:**
- Produces: `SIMILAR_GAMES_LIMIT = 12`, `GENERIC_STEAM_TAG_IDS: ReadonlySet<number>`, `orderTagsSpecificFirst(tags: number[]): number[]`.

- [ ] **Step 1: Write the failing tests**

Append to the end of `similar-games.test.ts` (after the `fetchSimilarGames` describe block so the helpers above it are initialized), and add `orderTagsSpecificFirst` to the import list at the top of the file:

```ts
describe("orderTagsSpecificFirst", () => {
  it("moves generic tags behind specific ones, keeping vote order in each group", () => {
    // 122 RPG and 4182 Singleplayer are generic; 4747, 1695, 1684 are specific.
    assert.deepEqual(orderTagsSpecificFirst([122, 4747, 1695, 4182, 1684]), [
      4747, 1695, 1684, 122, 4182,
    ]);
  });

  it("returns tags unchanged when none are generic", () => {
    assert.deepEqual(orderTagsSpecificFirst([1698, 5613]), [1698, 5613]);
  });

  it("returns tags unchanged when all are generic", () => {
    assert.deepEqual(orderTagsSpecificFirst([4182, 492, 19, 21]), [
      4182, 492, 19, 21,
    ]);
  });
});
```

Also update the two existing limit tests in the `normalizeSimilarGamesResponse` block:

- Rename `"drops malformed download sources and limits results to nine"` to `"drops malformed download sources and limits results to twelve"`, change `Array.from({ length: 12 }` to `Array.from({ length: 15 }`, and `assert.equal(results.length, 9)` to `assert.equal(results.length, 12)`.
- In `"rejects blank identities, trims valid identities, and preserves the limit"`, change `Array.from({ length: 8 }` to `Array.from({ length: 11 }` and `assert.equal(results.length, 9)` to `assert.equal(results.length, 12)`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import ./scripts/register-ts-node.mjs --test src/renderer/src/hooks/similar-games.test.ts`
Expected: FAIL. `orderTagsSpecificFirst` is not exported; the two limit tests fail on `12`.

- [ ] **Step 3: Implement**

Replace lines 3-5 of `similar-games.ts` (the `SIMILAR_GAMES_LIMIT` and `SIMILAR_GAMES_TAG_TIERS` constants) with:

```ts
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
```

Then, so the file still compiles, temporarily keep the old tier behaviour by adding right after it:

```ts
// Replaced by SIMILAR_GAMES_TAG_QUERIES in Task 3.
export const SIMILAR_GAMES_TAG_TIERS = [6, 5, 4];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import ./scripts/register-ts-node.mjs --test src/renderer/src/hooks/similar-games.test.ts`
Expected: all pass. The existing `fetchSimilarGames` tests still use the old 9-limit `/similar` `take` in their expectations; they pass because `fetchSimilarGames` still uses `SIMILAR_GAMES_LIMIT` for `take` and the test asserts `take: 9`. If they fail on `take: 12`, update those assertions to `12` now; Task 3 rewrites them anyway.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/hooks/similar-games.ts src/renderer/src/hooks/similar-games.test.ts
git commit -m "feat(similar-games): order tags specific-first and raise limit to 12"
```

---

### Task 2: Ranking with hit-count scoring

**Files:**
- Modify: `src/renderer/src/hooks/similar-games.ts` (`SimilarGame`, `normalizeSimilarGame`, `normalizeSimilarGamesResponse`)
- Test: `src/renderer/src/hooks/similar-games.test.ts`

**Interfaces:**
- Consumes: `SIMILAR_GAMES_LIMIT`.
- Produces: `SimilarGame.sharedTagIds: number[]`; `interface TagQueryResult { tags: number[]; edges: unknown[] }`; `rankSimilarGames(tagResults: TagQueryResult[], similarResponse: unknown, query: SimilarGamesQuery): SimilarGame[]`; `similarGameKey(game: { shop: string; objectId: string }): string`.

- [ ] **Step 1: Write the failing tests**

Add `rankSimilarGames` to the test file imports. Update the `game()` helper near the top of the test file to include the new field:

```ts
  downloadSources: [],
  sharedTagIds: [],
  ...overrides,
```

Append after the `orderTagsSpecificFirst` block:

```ts
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
      [],
      query
    );

    assert.deepEqual(
      results.map(({ objectId }) => objectId),
      ["a", "b", "c"]
    );
  });

  it("records the narrowest query's tags as shared tags", () => {
    const [a, b] = rankSimilarGames(
      [
        { tags: [1, 2, 3, 4, 5, 6], edges: [searchEdge("a")] },
        { tags: [1, 2, 3, 4], edges: [searchEdge("a"), searchEdge("b")] },
      ],
      [],
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
      [],
      query
    );

    assert.deepEqual(
      results.map(({ objectId }) => objectId),
      ["with-source", "no-source"]
    );
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
      [],
      query
    );

    assert.deepEqual(
      results.map(({ objectId }) => objectId),
      ["once", "twice"]
    );
  });

  it("appends similar-endpoint games after tag matches without shared tags", () => {
    const results = rankSimilarGames(
      [{ tags: [1, 2, 3, 4], edges: [searchEdge("tagged")] }],
      [game("tagged"), game("extra")],
      query
    );

    assert.deepEqual(
      results.map(({ objectId }) => objectId),
      ["tagged", "extra"]
    );
    assert.deepEqual(results[0].sharedTagIds, [1, 2, 3, 4]);
    assert.deepEqual(results[1].sharedTagIds, []);
  });

  it("drops the current game and caps at twelve", () => {
    const edges = Array.from({ length: 14 }, (_, index) =>
      searchEdge(`t-${index}`)
    );
    const results = rankSimilarGames(
      [{ tags: [1, 2, 3, 4], edges: [searchEdge("current"), ...edges] }],
      [game("t-1"), game("more")],
      query
    );

    assert.equal(results.length, 12);
    assert.ok(results.every(({ objectId }) => objectId !== "current"));
    assert.equal(results.filter(({ objectId }) => objectId === "t-1").length, 1);
  });

  it("treats a malformed similar response as empty", () => {
    const results = rankSimilarGames(
      [{ tags: [1, 2, 3, 4], edges: [searchEdge("a")] }],
      {},
      query
    );

    assert.deepEqual(
      results.map(({ objectId }) => objectId),
      ["a"]
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import ./scripts/register-ts-node.mjs --test src/renderer/src/hooks/similar-games.test.ts`
Expected: FAIL, `rankSimilarGames` is not exported.

- [ ] **Step 3: Implement**

In `similar-games.ts`:

Add to `SimilarGame` after `downloadSources`:

```ts
  // Tags of the narrowest query that returned this game; empty for /similar results.
  sharedTagIds: number[];
```

In `normalizeSimilarGame`, add to the returned object:

```ts
    sharedTagIds: [],
```

Add below `normalizeSimilarGame`:

```ts
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
```

Replace the body of `normalizeSimilarGamesResponse` with:

```ts
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
```

Add after it:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import ./scripts/register-ts-node.mjs --test src/renderer/src/hooks/similar-games.test.ts`
Expected: all pass, including the untouched `normalizeSimilarGamesResponse` tests.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/hooks/similar-games.ts src/renderer/src/hooks/similar-games.test.ts
git commit -m "feat(similar-games): rank candidates by query hit count"
```

---

### Task 3: Parallel fetch with four queries and resilient fallbacks

**Files:**
- Modify: `src/renderer/src/hooks/similar-games.ts` (`searchByTags`, `fetchTagMatches`, `fetchSimilarGames`, remove `SIMILAR_GAMES_TAG_TIERS`)
- Test: `src/renderer/src/hooks/similar-games.test.ts` (rewrite the `fetchSimilarGames` block)

**Interfaces:**
- Consumes: `orderTagsSpecificFirst`, `rankSimilarGames`, `TagQueryResult`.
- Produces: `SIMILAR_GAMES_TAG_QUERIES`, `type SimilarGamesSortBy = "popularity" | "reviewScore"`; `fetchSimilarGames` keeps its signature `(query, api, downloadSourceIds?) => Promise<SimilarGame[]>`.

- [ ] **Step 1: Rewrite the `fetchSimilarGames` tests**

Extend `createApi` so `similar` may be a function, mirroring `tags`:

```ts
const createApi = (handlers: {
  tags?: unknown | (() => Promise<unknown>);
  search?: (tags: number[], sortBy: string) => unknown;
  similar?: unknown | (() => Promise<unknown>);
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
  };

  return { api, calls };
};

const paths = (calls: ApiCall[]) => calls.map((call) => call.path);

const searchCalls = (calls: ApiCall[]) =>
  calls
    .filter((call) => call.method === "post")
    .map((call) => {
      const { tags, sortBy, take } = (
        call.options as { data: { tags: number[]; sortBy: string; take: number } }
      ).data;
      return { tags, sortBy, take };
    });
```

Replace the whole `describe("fetchSimilarGames", ...)` block with:

```ts
describe("fetchSimilarGames", () => {
  const steamQuery = { objectId: "current", shop: "steam" as const };
  // 21 (Adventure) and 4166 (Atmospheric) are generic and move to the back.
  const tags = ["21", "1698", "1719", "5923", "1738", "4166", "7"];
  const ordered = [1698, 1719, 5923, 1738, 7, 21, 4166];

  beforeEach(() => clearSimilarGamesCache());

  it("runs four tag searches and the similar endpoint in parallel", async () => {
    const { api, calls } = createApi({
      tags: { tags },
      search: (requested) => [searchEdge(`len-${requested.length}`)],
      similar: [game("from-similar")],
    });

    const results = await fetchSimilarGames(steamQuery, api, ["source-a"]);

    assert.deepEqual(searchCalls(calls), [
      { tags: ordered.slice(0, 6), sortBy: "popularity", take: 15 },
      { tags: ordered.slice(0, 5), sortBy: "popularity", take: 15 },
      { tags: ordered.slice(0, 5), sortBy: "reviewScore", take: 15 },
      { tags: ordered.slice(0, 4), sortBy: "popularity", take: 15 },
    ]);
    assert.deepEqual(paths(calls).slice(0, 2), [
      "/games/steam/current",
      "/catalogue/steam/current/similar",
    ]);
    assert.deepEqual(calls[1].options, {
      params: { take: 12, downloadSourceIds: ["source-a"] },
      needsAuth: false,
    });
    assert.deepEqual(calls[2].options, {
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
    assert.deepEqual(
      results.map(({ objectId }) => objectId),
      ["len-5", "len-6", "len-4", "from-similar"]
    );
    assert.equal(
      results[1].coverImageUrl,
      "https://shared.steamstatic.com/store_item_assets/steam/apps/len-6/library_600x900_2x.jpg"
    );
    assert.deepEqual(results[1].sharedTagIds, ordered.slice(0, 6));
    assert.deepEqual(results[1].downloadSources, ["Source"]);
  });

  it("requests only the queries the game has enough tags for", async () => {
    const { api, calls } = createApi({
      tags: { tags: tags.slice(0, 5) },
      search: () => [searchEdge("a")],
    });

    await fetchSimilarGames(steamQuery, api);

    assert.deepEqual(
      searchCalls(calls).map(({ tags, sortBy }) => [tags.length, sortBy]),
      [
        [5, "popularity"],
        [5, "reviewScore"],
        [4, "popularity"],
      ]
    );
  });

  it("drops non-numeric tag ids before tiering", async () => {
    const { api, calls } = createApi({
      tags: { tags: ["x", "1698", "1719", "5923", "1738", null] },
      search: () => [searchEdge("a")],
    });

    await fetchSimilarGames(steamQuery, api);

    assert.deepEqual(
      searchCalls(calls).map(({ tags }) => tags),
      [[1698, 1719, 5923, 1738]]
    );
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

  it("uses the similar endpoint alone when every tag search fails", async () => {
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

  it("keeps the other searches when one tag search fails", async () => {
    const { api } = createApi({
      tags: { tags },
      search: (requested) => {
        if (requested.length === 6) throw new Error("search down");
        return [searchEdge(`len-${requested.length}`)];
      },
    });

    const results = await fetchSimilarGames(steamQuery, api);

    assert.deepEqual(
      results.map(({ objectId }) => objectId),
      ["len-5", "len-4"]
    );
  });

  it("keeps tag matches when the similar endpoint fails", async () => {
    const { api } = createApi({
      tags: { tags },
      search: () => [searchEdge("tagged")],
      similar: () => Promise.reject(new Error("similar down")),
    });

    const results = await fetchSimilarGames(steamQuery, api);

    assert.deepEqual(
      results.map(({ objectId }) => objectId),
      ["tagged"]
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
          params: { take: 12, downloadSourceIds: ["source-b", "source-a"] },
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
```

Add `beforeEach` to the `node:test` import and `clearSimilarGamesCache` to the module import. `clearSimilarGamesCache` is implemented in Task 4; for this task add a stub export to `similar-games.ts` so the file compiles:

```ts
export const clearSimilarGamesCache = () => {};
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import ./scripts/register-ts-node.mjs --test src/renderer/src/hooks/similar-games.test.ts`
Expected: FAIL on the four-query, parallel, partial-failure, and `take: 12` / `take: 15` expectations.

- [ ] **Step 3: Implement**

In `similar-games.ts`, delete the temporary `SIMILAR_GAMES_TAG_TIERS` export from Task 1 and add after `orderTagsSpecificFirst`:

```ts
const SEARCH_TAKE = 15; // /catalogue/search rejects take below 5

export type SimilarGamesSortBy = "popularity" | "reviewScore";

export interface SimilarGamesTagQuery {
  size: number;
  sortBy: SimilarGamesSortBy;
}

// Narrowest first; this order also decides which query's tags a game shares.
export const SIMILAR_GAMES_TAG_QUERIES: readonly SimilarGamesTagQuery[] = [
  { size: 6, sortBy: "popularity" },
  { size: 5, sortBy: "popularity" },
  { size: 5, sortBy: "reviewScore" },
  { size: 4, sortBy: "popularity" },
];
```

Replace `searchByTags`, `fetchTagMatches`, and `fetchSimilarGames` with:

```ts
const withSteamCover = (edge: unknown) => {
  const candidate = edge as { objectId?: unknown; shop?: unknown } | null;
  if (typeof candidate?.objectId !== "string" || candidate.shop !== "steam") {
    return edge;
  }

  return { ...candidate, coverImageUrl: steamCoverImageUrl(candidate.objectId) };
};

const searchByTags = async (
  tags: number[],
  sortBy: SimilarGamesSortBy,
  post: SimilarGamesPost,
  downloadSourceIds: string[]
): Promise<TagQueryResult> => {
  const response = await post("/catalogue/search", {
    data: {
      take: SEARCH_TAKE,
      skip: 0,
      title: "",
      sortBy,
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

  return { tags, edges: Array.isArray(edges) ? edges.map(withSteamCover) : [] };
};

const fetchTagMatches = async (
  query: SimilarGamesQuery,
  api: SimilarGamesApi,
  downloadSourceIds: string[]
): Promise<TagQueryResult[]> => {
  let tags: number[];
  try {
    tags = orderTagsSpecificFirst(await fetchGameTags(query, api.get));
  } catch {
    return [];
  }

  const settled = await Promise.allSettled(
    SIMILAR_GAMES_TAG_QUERIES.filter(({ size }) => size <= tags.length).map(
      ({ size, sortBy }) =>
        searchByTags(tags.slice(0, size), sortBy, api.post, downloadSourceIds)
    )
  );

  return settled.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : []
  );
};

const fetchSimilarEndpoint = (
  query: SimilarGamesQuery,
  get: SimilarGamesGet,
  downloadSourceIds: string[]
) =>
  get(`/catalogue/${query.shop}/${encodeURIComponent(query.objectId)}/similar`, {
    params: { take: SIMILAR_GAMES_LIMIT, downloadSourceIds },
    needsAuth: false,
  }).catch(() => []);

export const fetchSimilarGames = async (
  query: SimilarGamesQuery,
  api: SimilarGamesApi,
  downloadSourceIds: string[] = []
) => {
  if (!isSupportedShop(query.shop) || !query.objectId) return [];

  const [tagResults, similarResponse] = await Promise.all([
    query.shop === "steam"
      ? fetchTagMatches(query, api, downloadSourceIds)
      : Promise.resolve([]),
    fetchSimilarEndpoint(query, api.get, downloadSourceIds),
  ]);

  return rankSimilarGames(tagResults, similarResponse, query);
};
```

Keep `fetchGameTags` as it is: it already maps with `Number` and filters with `Number.isInteger`, which drops `"x"` and `null`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import ./scripts/register-ts-node.mjs --test src/renderer/src/hooks/similar-games.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/hooks/similar-games.ts src/renderer/src/hooks/similar-games.test.ts
git commit -m "feat(similar-games): run four tag queries and /similar in parallel"
```

---

### Task 4: Session cache

**Files:**
- Modify: `src/renderer/src/hooks/similar-games.ts` (`fetchSimilarGames`, replace the `clearSimilarGamesCache` stub)
- Test: `src/renderer/src/hooks/similar-games.test.ts`

**Interfaces:**
- Produces: `getCachedSimilarGames(query: SimilarGamesQuery): SimilarGame[] | undefined`, `clearSimilarGamesCache(): void`.

- [ ] **Step 1: Write the failing tests**

Add `getCachedSimilarGames` to the test imports. Append inside the `fetchSimilarGames` describe block:

```ts
  it("returns cached results without calling the API again", async () => {
    const { api, calls } = createApi({
      tags: { tags },
      search: () => [searchEdge("a")],
    });

    const first = await fetchSimilarGames(steamQuery, api);
    const callCount = calls.length;
    const second = await fetchSimilarGames(steamQuery, api);

    assert.equal(second, first);
    assert.equal(calls.length, callCount);
    assert.equal(getCachedSimilarGames(steamQuery), first);
  });

  it("does not cache empty results", async () => {
    const { api, calls } = createApi({ tags: { tags }, search: () => [] });

    await fetchSimilarGames(steamQuery, api);
    const callCount = calls.length;
    await fetchSimilarGames(steamQuery, api);

    assert.equal(calls.length, callCount * 2);
    assert.equal(getCachedSimilarGames(steamQuery), undefined);
  });

  it("evicts the oldest entry past fifty games", async () => {
    const { api } = createApi({
      tags: { tags },
      search: () => [searchEdge("a")],
    });

    for (let index = 0; index < 51; index += 1) {
      await fetchSimilarGames({ objectId: `g-${index}`, shop: "steam" }, api);
    }

    assert.equal(getCachedSimilarGames({ objectId: "g-0", shop: "steam" }), undefined);
    assert.ok(getCachedSimilarGames({ objectId: "g-1", shop: "steam" }));
    assert.ok(getCachedSimilarGames({ objectId: "g-50", shop: "steam" }));
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import ./scripts/register-ts-node.mjs --test src/renderer/src/hooks/similar-games.test.ts`
Expected: FAIL, `getCachedSimilarGames` is not exported and repeat calls hit the API.

- [ ] **Step 3: Implement**

Replace the `clearSimilarGamesCache` stub with:

```ts
const CACHE_LIMIT = 50;
const similarGamesCache = new Map<string, SimilarGame[]>();

export const getCachedSimilarGames = (query: SimilarGamesQuery) =>
  similarGamesCache.get(similarGameKey(query));

export const clearSimilarGamesCache = () => similarGamesCache.clear();

const cacheSimilarGames = (query: SimilarGamesQuery, games: SimilarGame[]) => {
  const key = similarGameKey(query);

  similarGamesCache.delete(key);
  similarGamesCache.set(key, games);
  if (similarGamesCache.size > CACHE_LIMIT) {
    similarGamesCache.delete(similarGamesCache.keys().next().value as string);
  }
};
```

In `fetchSimilarGames`, after the shop guard add:

```ts
  const cached = getCachedSimilarGames(query);
  if (cached) return cached;
```

and replace the final `return rankSimilarGames(...)` with:

```ts
  const results = rankSimilarGames(tagResults, similarResponse, query);
  if (results.length > 0) cacheSimilarGames(query, results);

  return results;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import ./scripts/register-ts-node.mjs --test src/renderer/src/hooks/similar-games.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/hooks/similar-games.ts src/renderer/src/hooks/similar-games.test.ts
git commit -m "feat(similar-games): cache ranked results per game for the session"
```

---

### Task 5: View building (ownership and shared tag names)

**Files:**
- Modify: `src/renderer/src/hooks/similar-games.ts`
- Test: `src/renderer/src/hooks/similar-games.test.ts`

**Interfaces:**
- Consumes: `SimilarGame`, `similarGameKey`.
- Produces: `interface SimilarGameView extends SimilarGame { sharedTags: string[]; inLibrary: boolean }`, `SHARED_TAGS_SHOWN = 2`, `buildSimilarGameViews(games: SimilarGame[], ownedKeys: ReadonlySet<string>, tagNameById: ReadonlyMap<number, string>): SimilarGameView[]`.

- [ ] **Step 1: Write the failing tests**

Add `buildSimilarGameViews` to the test imports. Append at the end of the file:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import ./scripts/register-ts-node.mjs --test src/renderer/src/hooks/similar-games.test.ts`
Expected: FAIL, `buildSimilarGameViews` is not exported.

- [ ] **Step 3: Implement**

Append to `similar-games.ts`:

```ts
export const SHARED_TAGS_SHOWN = 2;

export interface SimilarGameView extends SimilarGame {
  sharedTags: string[];
  inLibrary: boolean;
}

// Ownership and names are applied at render time so cached lists stay valid
// when the library or language changes.
export const buildSimilarGameViews = (
  games: SimilarGame[],
  ownedKeys: ReadonlySet<string>,
  tagNameById: ReadonlyMap<number, string>
): SimilarGameView[] => {
  const views = games.map((game) => ({
    ...game,
    inLibrary: ownedKeys.has(similarGameKey(game)),
    sharedTags: game.sharedTagIds
      .flatMap((id) => {
        const name = tagNameById.get(id);
        return name ? [name] : [];
      })
      .slice(0, SHARED_TAGS_SHOWN),
  }));

  return [
    ...views.filter((view) => !view.inLibrary),
    ...views.filter((view) => view.inLibrary),
  ];
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import ./scripts/register-ts-node.mjs --test src/renderer/src/hooks/similar-games.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/hooks/similar-games.ts src/renderer/src/hooks/similar-games.test.ts
git commit -m "feat(similar-games): build card views with ownership and shared tag names"
```

---

### Task 6: Hook wiring (cache, library, tag names)

**Files:**
- Modify: `src/renderer/src/hooks/use-catalogue.ts:16` (export `getLocalizedSteamMetadata`)
- Modify: `src/renderer/src/hooks/use-similar-games.ts` (full rewrite)

**Interfaces:**
- Consumes: `buildSimilarGameViews`, `fetchSimilarGames`, `getCachedSimilarGames`, `similarGameKey`, `SimilarGameView`; redux `state.catalogueSearch.steamUserTags`, `setTags` from `@renderer/features`; `useLibrary`.
- Produces: `useSimilarGames(query) => { games: SimilarGameView[]; isLoading: boolean; isEligible: boolean }`.

- [ ] **Step 1: Export the metadata helper**

In `use-catalogue.ts` line 16 change `async function getLocalizedSteamMetadata<T>(` to `export async function getLocalizedSteamMetadata<T>(`.

- [ ] **Step 2: Confirm the redux state key**

Run: `grep -n "state.catalogueSearch" src/renderer/src/pages/catalogue/catalogue.tsx | head -2`
Expected: a line selecting `state.catalogueSearch`. If the key differs, use that key in Step 3.

- [ ] **Step 3: Rewrite the hook**

Replace the contents of `use-similar-games.ts` with:

```ts
import { useEffect, useMemo, useRef, useState } from "react";
import { orderBy } from "lodash-es";
import { useTranslation } from "react-i18next";

import { logger } from "@renderer/logger";
import { levelDBService } from "@renderer/services/leveldb.service";
import { setTags } from "@renderer/features";
import type { DownloadSource } from "@types";
import { useAppDispatch, useAppSelector } from "./redux";
import { useLibrary } from "./use-library";
import { getLocalizedSteamMetadata } from "./use-catalogue";
import {
  buildSimilarGameViews,
  fetchSimilarGames,
  getCachedSimilarGames,
  similarGameKey,
  type SimilarGame,
  type SimilarGamesApi,
  type SimilarGamesQuery,
} from "./similar-games";

const useSteamTagNames = (enabled: boolean) => {
  const dispatch = useAppDispatch();
  const { i18n } = useTranslation();
  const language = i18n.language.split("-")[0] || "en";
  const tagNames = useAppSelector(
    (state) => state.catalogueSearch.steamUserTags[language]
  );

  useEffect(() => {
    if (!enabled || tagNames) return;

    let cancelled = false;
    getLocalizedSteamMetadata<Record<string, number>>(
      "/catalogue/steam/tags",
      i18n.language
    )
      .then((tags) => {
        if (!cancelled) dispatch(setTags(tags));
      })
      .catch((error) => logger.error("Failed to fetch steam tags", error));

    return () => {
      cancelled = true;
    };
  }, [dispatch, enabled, i18n.language, tagNames]);

  return useMemo(
    () =>
      new Map(
        Object.entries(tagNames ?? {}).map(([name, id]) => [id, name] as const)
      ),
    [tagNames]
  );
};

export const useSimilarGames = (query: SimilarGamesQuery) => {
  const [games, setGames] = useState<SimilarGame[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [resultQueryKey, setResultQueryKey] = useState("");
  const requestIdRef = useRef(0);
  const { objectId, shop } = query;
  const queryKey = `${shop}:${objectId}`;
  const isEligible =
    Boolean(objectId) && (shop === "steam" || shop === "launchbox");
  const cached = getCachedSimilarGames({ objectId, shop });

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    const stableQuery: SimilarGamesQuery = { objectId, shop };
    const cachedGames = getCachedSimilarGames(stableQuery);

    setResultQueryKey(queryKey);
    if (!isEligible || cachedGames) {
      setGames(cachedGames ?? []);
      setIsLoading(false);
      return;
    }

    setGames([]);
    setIsLoading(true);

    const api: SimilarGamesApi = {
      get: (path, options) =>
        globalThis.window.electron.hydraApi.get<unknown>(path, options),
      post: (path, options) =>
        globalThis.window.electron.hydraApi.post<unknown>(path, options),
    };

    const loadSimilarGames = async () => {
      const sources = (await levelDBService.values(
        "downloadSources"
      )) as DownloadSource[];

      if (requestId !== requestIdRef.current) return;

      const downloadSourceIds = orderBy(sources, "createdAt", "desc").map(
        (source) => source.id
      );
      const results = await fetchSimilarGames(
        stableQuery,
        api,
        downloadSourceIds
      );

      if (requestId === requestIdRef.current) setGames(results);
    };

    void loadSimilarGames()
      .catch((error) => {
        if (requestId !== requestIdRef.current) return;
        logger.error("Failed to fetch similar games", error);
        setGames([]);
      })
      .finally(() => {
        if (requestId === requestIdRef.current) setIsLoading(false);
      });

    return () => {
      requestIdRef.current += 1;
    };
  }, [isEligible, objectId, queryKey, shop]);

  const tagNameById = useSteamTagNames(isEligible && shop === "steam");
  const { library } = useLibrary();
  const ownedKeys = useMemo(
    () => new Set(library.map((game) => similarGameKey(game))),
    [library]
  );

  const hasCurrentResults = resultQueryKey === queryKey;
  const currentGames = hasCurrentResults ? games : (cached ?? []);
  const views = useMemo(
    () => buildSimilarGameViews(currentGames, ownedKeys, tagNameById),
    [currentGames, ownedKeys, tagNameById]
  );

  return {
    games: views,
    isLoading: isEligible && !cached && (!hasCurrentResults || isLoading),
    isEligible,
  };
};
```

- [ ] **Step 4: Typecheck**

Run: `grep -rn "useSimilarGames" src/big-picture | head -3` to see whether Big Picture consumes the hook. It only needs a superset of the old fields, which `SimilarGameView` is.

Run: `yarn typecheck:web`
Expected: exit 0. If `state.catalogueSearch` is flagged, use the key found in Step 2. If `library.map((game) => similarGameKey(game))` is flagged because `LibraryGame.shop` is `GameShop`, `similarGameKey` already accepts `{ shop: string; objectId: string }` from Task 2, so the error means Task 2 narrowed it; widen it there.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/hooks/use-catalogue.ts src/renderer/src/hooks/use-similar-games.ts
git commit -m "feat(similar-games): serve cached results and resolve ownership and tag names in hook"
```

---

### Task 7: Card caption and library badge

**Files:**
- Modify: `src/renderer/src/pages/game-details/similar-games/similar-games.tsx:122-140`
- Modify: `src/renderer/src/pages/game-details/similar-games/similar-games.scss` (`&__slide`, new `&__caption`, `&__badge`)

**Interfaces:**
- Consumes: `SimilarGameView.sharedTags`, `SimilarGameView.inLibrary` via `useSimilarGames`.

- [ ] **Step 1: Render caption and badge**

In `similar-games.tsx` replace the slide body inside `games.map(...)`:

```tsx
              {games.map((similarGame) => {
                const caption = similarGame.sharedTags.join(" · ");

                return (
                  <SimilarGamesSlide
                    key={`${similarGame.shop}:${similarGame.objectId}`}
                  >
                    <VerticalCoverCard
                      className="similar-games__card"
                      gameTitle={similarGame.title}
                      coverImageUrls={[
                        similarGame.coverImageUrl,
                        similarGame.libraryImageUrl,
                        similarGame.iconUrl,
                      ]}
                      useClassicsLayout={similarGame.shop === "launchbox"}
                      onClick={() => navigate(buildGameDetailsPath(similarGame))}
                    >
                      {similarGame.inLibrary ? (
                        <span className="similar-games__badge">
                          {t("already_in_library")}
                        </span>
                      ) : null}
                    </VerticalCoverCard>
                    <p className="similar-games__caption" title={caption}>
                      {caption}
                    </p>
                  </SimilarGamesSlide>
                );
              })}
```

This drops `showTitleTooltip={false}` so the card's default title tooltip is back.

- [ ] **Step 2: Style them**

In `similar-games.scss` extend `&__slide` and add the two blocks after `&__card:hover`:

```scss
  &__slide {
    display: flex;
    flex: 0 0 calc(100% / 3);
    flex-direction: column;
    gap: calc(globals.$spacing-unit / 2);
    min-width: 0;
    padding: 3px globals.$spacing-unit;
  }

  &__card:hover {
    transform: scale($card-hover-scale);
  }

  &__caption {
    min-height: 1.2em;
    margin: 0;
    overflow: hidden;
    font-size: 12px;
    line-height: 1.2;
    color: globals.$body-color;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__badge {
    position: absolute;
    top: globals.$spacing-unit;
    right: globals.$spacing-unit;
    z-index: 1;
    padding: 2px 6px;
    font-size: 11px;
    font-weight: 600;
    color: globals.$muted-color;
    background: rgba(0, 0, 0, 0.7);
    border-radius: 4px;
  }
```

- [ ] **Step 3: Lint and typecheck**

Run: `yarn lint && yarn typecheck:web`
Expected: exit 0, no warnings on the touched files.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/pages/game-details/similar-games/similar-games.tsx src/renderer/src/pages/game-details/similar-games/similar-games.scss
git commit -m "feat(similar-games): show shared tags and library badge on cards"
```

---

### Task 8: Full verification and rebuild

**Files:**
- No source edits unless verification fails.

- [ ] **Step 1: Run the full checks**

Run: `yarn test && yarn lint && yarn typecheck && yarn format-check`
Expected: all exit 0. If `format-check` flags a touched file, run `yarn prettier --write <file>` and amend the last commit for that file.

- [ ] **Step 2: Rebuild the patched app**

Close the running patched app first (single-instance lock). Then:

```bash
pkill -f 'dist/linux-unpacked/hydralauncher$'; yarn build && yarn electron-builder --dir
```

Expected: `dist/linux-unpacked/hydralauncher` updated, no errors in output.

- [ ] **Step 3: Manual check in the app**

Launch with `gio launch ~/Desktop/hydra-patched.desktop` and open these game pages:

| Game | Steam id | Expect |
| --- | --- | --- |
| Return to Monkey Island | 2060130 | Neighbours are adventure or point-and-click games; captions like "Point & Click · Puzzle" |
| Hades | 1145360 | Roguelike or action roguelike neighbours; captions name those tags |
| Any game you own with owned neighbours | any | Owned neighbours carry the "Already in library" pill and sit at the end of the carousel |
| Any of the above, navigate away and back | - | Section appears without a skeleton |
| Add a neighbour to the library while on the page | - | Its card gains the pill and moves to the end without a refetch |

Also confirm a LaunchBox game page still shows its section, and a `custom` game page shows none.

- [ ] **Step 4: Push and record**

```bash
git push fork local/v4.1.6-recently-downloaded
```

Update `~/.claude/projects/-home-borislav-github-hydra/memory/hydra-patched-build-workflow.md`: in the "As of" bullet, replace the "tag-based 'More like this' (committed, cde6323c)" clause with "tag-based 'More like this' with hit-count ranking, shared-tag captions, library badge and session cache (cde6323c then the 2026-10-14 similar-games commits)". Commit and push that memory repo.
