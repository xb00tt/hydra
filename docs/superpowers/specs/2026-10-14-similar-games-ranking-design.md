# "More like this" ranking and UX improvements

Date: 2026-10-14
Scope: renderer only. Files under `src/renderer/src/hooks/` and `src/renderer/src/pages/game-details/similar-games/`.
Status: approved design, pending implementation plan.

## Problem

The "More like this" section on the game details page ranks Steam games by
AND-matching the top 6, 5 and 4 vote-ordered Steam user tags against
`POST /catalogue/search`, then tops up from `GET /catalogue/{shop}/{id}/similar`.
Three weaknesses remain:

1. The top tags of most games are generic ("Singleplayer", "Indie", "Action",
   "Adventure"). AND-matching four of those is a popularity chart, not a
   similarity match.
2. Results are deduplicated by first appearance with no scoring, and every
   query sorts by popularity, so the same hub games dominate many pages.
3. The UI gives no reason for a recommendation, shows games the user already
   owns, and waits for two or three serial round trips on every visit.

The backend is closed source, so every change is client side.

## Goals

- Rank by discriminating tags, score candidates by how many queries hit them.
- Show the user why a game is recommended (shared tags).
- Mark owned games and sort them last.
- Fire all network calls in parallel; cache per game for the session.
- Keep the LaunchBox path (no tags) unchanged.

Non-goals: per-candidate tag fetches (true Jaccard), progressive rendering,
LaunchBox similarity, backend changes.

## Ranking

### Tag ordering

`fetchGameTags` returns the game's tag ids in vote order. Before tiering,
partition them into two stable groups: specific tags first, then generic
tags, each keeping vote order. Generic tags are a fixed id set
`GENERIC_STEAM_TAG_IDS` in `similar-games.ts`, ids verified against the live
`/catalogue/steam/tags?language=en` response on 2026-10-14:

| Tag | Id |
| --- | --- |
| Singleplayer | 4182 |
| Multiplayer | 3859 |
| Online Co-Op | 3843 |
| Co-op | 1685 |
| Indie | 492 |
| Action | 19 |
| Adventure | 21 |
| Casual | 597 |
| Simulation | 599 |
| Strategy | 9 |
| RPG | 122 |
| Free to Play | 113 |
| Early Access | 493 |
| Great Soundtrack | 1756 |
| Atmospheric | 4166 |
| 2D | 3871 |
| 3D | 4191 |
| Controller | 7481 |
| Difficult | 4026 |
| Cute | 4726 |
| Colorful | 4305 |
| Funny | 4136 |
| Relaxing | 1654 |
| Family Friendly | 5350 |
| Classic | 1693 |
| Moddable | 1669 |
| Stylized | 4252 |
| Realistic | 4175 |
| Violent | 4667 |
| Gore | 4345 |
| Mature | 5611 |
| Nudity | 6650 |
| Sexual Content | 12095 |

Partitioning rather than dropping keeps the tier sizes intact for games with
few specific tags. Tags not in the set ("Point & Click", "Detective",
"Pixel Graphics", "Story Rich", "Open World", "Horror", ...) are treated as
specific.

### Queries

For Steam games with at least 4 tags after partitioning, run these searches in
parallel. Each uses the existing `/catalogue/search` payload shape with
`take: 15` (the endpoint rejects `take` below 5) and `skip: 0`.

| Key | Tags | sortBy | Purpose |
| --- | --- | --- | --- |
| tier6 | first 6 | popularity desc | tight match |
| tier5 | first 5 | popularity desc | medium match |
| rated5 | first 5 | reviewScore desc | diversity, surfaces well-reviewed small games |
| tier4 | first 4 | popularity desc | loose match |

A query whose tier size exceeds the tag count is skipped, as today.

`GET /catalogue/{shop}/{id}/similar?take=12` runs in parallel with the tag
path from the start, not after it. Both sides are awaited with
`Promise.allSettled`; a rejected side contributes an empty list.

### Scoring and order

Each candidate from the tag queries is normalized with the existing
`normalizeSimilarGame`, keyed by `shop:objectId`, and accumulates:

- `hits`: number of queries that returned it.
- `sharedTagIds`: the tag list of the narrowest query (fewest tags) that
  returned it. tier6 beats tier5 and rated5, which beat tier4. Since tags are
  specific-first, the head of this list is the most specific overlap.
- `firstSeen`: insertion index in the processing order tier6, tier5, rated5,
  tier4 (narrowest first, stable).
- `hasDownloadSources`: `downloadSources.length > 0`.

Candidates from `/similar` that are not already present are appended with
`hits: 0`, empty `sharedTagIds`, and their own `firstSeen` after all tag
results.

Sort order, applied in `similar-games.ts` (pure, no React):

1. `hits` descending
2. `hasDownloadSources` descending
3. `firstSeen` ascending

The current game is dropped, duplicates collapsed, and the list capped at
`SIMILAR_GAMES_LIMIT = 12` (four carousel pages of three).

Ownership is not part of this sort. The hook applies it (see below) so the
cached list stays valid when the library changes.

### Fallbacks

Unchanged in spirit: fewer than 4 tags, a failed tag fetch, or all tag
queries failing yields the `/similar` list alone. A single failed tag query
is dropped (`allSettled`) and the others still count. If `/similar` fails,
the tag results stand alone. The section shows "No similar games found" only
when both sides are empty.

LaunchBox games skip the tag path and use `/similar` alone, as today.

## Shared tag names

`SimilarGame` gains `sharedTagIds: number[]`. Names come from the existing
redux slice `catalogueSearch.steamUserTags`, a `language -> name -> id` map
already loaded by the catalogue page. `useSimilarGames`:

- reads `steamUserTags[language]` where `language` is the current i18n
  language's base code (same rule as `getLocalizedSteamMetadata`);
- if that entry is missing, calls `getLocalizedSteamMetadata("/catalogue/steam/tags", i18n.language)`
  (exported from `use-catalogue.ts`, currently module private) and dispatches
  `setTags`, once per language;
- inverts the map to `id -> name` with `useMemo`.

For each game the hook derives `sharedTags: string[]`, the first two
`sharedTagIds` that resolve to a name. Ids with no name are skipped. If the
name map is unavailable, `sharedTags` is empty and the caption is omitted;
the list still renders.

## Ownership

The hook reads `state.library.value` and marks each game
`inLibrary: boolean` by matching `shop` and `objectId`, the same test the
catalogue uses. It then stable-sorts the cached list so `inLibrary: false`
comes first. This happens in a `useMemo` over the cached list and the
library, so adding a game to the library updates the section without a
refetch.

## Cache

`similar-games.ts` keeps a module-level `Map<string, SimilarGame[]>` keyed
`shop:objectId` holding the ranked, ownership-free list. Reads return the
cached array when present; writes evict the oldest entry past 50. Only
successful, non-empty results are cached, so a transient failure is retried
on the next visit. The cache lives for the renderer session; no persistence.

The hook reports `isLoading: false` immediately on a cache hit so returning
to a game shows the section without a skeleton.

## UI

`similar-games.tsx`:

- Each slide renders the `VerticalCoverCard` followed by a caption
  `div.similar-games__caption` containing `sharedTags.join(" · ")`. One line,
  `text-overflow: ellipsis`, muted color, small font. When `sharedTags` is
  empty the caption is still rendered empty so covers in a row align.
- Owned games render a pill `span.similar-games__badge` with
  `t("already_in_library")` through the card's `children` slot, positioned
  top-right over the cover. The key already exists in the `game_details`
  namespace for all 35 locales, so no locale edits.
- `showTitleTooltip` is enabled so long titles are readable on hover.
- `GAMES_PER_PAGE` stays 3; the carousel now has up to four pages.

`similar-games.scss` adds `&__caption` and `&__badge`. The card keeps its
hover scale; the caption does not scale.

## Data types

```ts
export interface SimilarGame {
  // existing fields unchanged
  sharedTagIds: number[]; // [] for /similar and LaunchBox results
}

export interface SimilarGameView extends SimilarGame {
  sharedTags: string[]; // resolved names, max 2
  inLibrary: boolean;
}
```

`fetchSimilarGames` returns `SimilarGame[]`; `useSimilarGames` returns
`{ games: SimilarGameView[], isLoading, isEligible }`.

## Testing

`similar-games.test.ts` (node test runner, `yarn test`) gains cases for:

- partition keeps vote order within specific and generic groups;
- a game returned by three queries outranks one returned by one;
- equal hits: a game with download sources ranks first;
- `sharedTagIds` is the narrowest query's tag list;
- `/similar` results append after tag results with `hits: 0`;
- cap at 12 and current-game exclusion still hold;
- one rejected tag query does not discard the others;
- rejected `/similar` leaves tag results intact, rejected tag path leaves
  `/similar` intact;
- second call for the same key does not hit the API (cache);
- empty results are not cached.

Ownership sort and name resolution live in the hook; there is no component
test infrastructure, so they are verified by rebuilding and checking a known
game (a point-and-click adventure, a roguelike, an owned game) in the app.

## Out of scope, revisit if results still weak

Sliding-window queries over tags 2..7, pair queries of the top specific tags,
and a `hydraScore` sorted tier. Each costs one more request per page view.
