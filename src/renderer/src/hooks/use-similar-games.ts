import { useEffect, useRef, useState } from "react";
import { orderBy } from "lodash-es";

import { logger } from "@renderer/logger";
import { levelDBService } from "@renderer/services/leveldb.service";
import type { DownloadSource } from "@types";
import {
  fetchSimilarGames,
  getCachedSimilarGames,
  isSimilarGamesQueryEligible,
  resolveSimilarGames,
  type SimilarGame,
  type SimilarGamesApi,
  type SimilarGamesQuery,
} from "./similar-games";

// Redux-free on purpose: Big Picture mounts this hook without a Provider.
// Ownership and tag names live in useSimilarGameViews.
export const useSimilarGames = (query: SimilarGamesQuery) => {
  const [games, setGames] = useState<SimilarGame[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [resultQueryKey, setResultQueryKey] = useState("");
  const requestIdRef = useRef(0);
  const { objectId, shop, source } = query;
  const queryKey = `${source}:${shop}:${objectId}`;
  const isEligible = isSimilarGamesQueryEligible({ objectId, shop, source });
  const cached = getCachedSimilarGames({ objectId, shop, source });

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    const stableQuery: SimilarGamesQuery = { objectId, shop, source };
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
      getSteamTags: (objectId) =>
        globalThis.window.electron.getSteamAppTags(objectId),
      getSteamRecommendations: (objectId) =>
        globalThis.window.electron.getSteamRecommendations(objectId),
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
  }, [isEligible, objectId, queryKey, shop, source]);

  const hasCurrentResults = resultQueryKey === queryKey;

  return {
    games: resolveSimilarGames(cached, hasCurrentResults, games),
    isLoading: isEligible && !cached && (!hasCurrentResults || isLoading),
    isEligible,
  };
};
