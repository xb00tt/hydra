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
  const views = useMemo(
    () =>
      buildSimilarGameViews(
        hasCurrentResults ? games : (cached ?? []),
        ownedKeys,
        tagNameById
      ),
    [cached, games, hasCurrentResults, ownedKeys, tagNameById]
  );

  return {
    games: views,
    isLoading: isEligible && !cached && (!hasCurrentResults || isLoading),
    isEligible,
  };
};
