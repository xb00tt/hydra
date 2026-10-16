import type { SteamRecommendation } from "@types";

const STEAM_ASSET_BASE_URL =
  "https://shared.steamstatic.com/store_item_assets/";

export interface SteamStoreItem {
  appid?: number;
  success?: number;
  type?: number;
  name?: string;
  tagids?: number[];
  assets?: {
    asset_url_format?: string;
    library_capsule?: string;
    library_capsule_2x?: string;
    header?: string;
  };
}

// The store's /recommended/morelike page opens with Steam's "More like this"
// grid; the grids after the first section divider are upcoming, free, demo
// and new releases, so they are cut off.
export const parseMoreLikeAppIds = (html: string, objectId: string) => {
  const grid =
    html
      .split("recommendation_area_ctn")[1]
      ?.split("morelike_section_divider")[0] ?? "";
  const appIds = [...grid.matchAll(/data-ds-appid="(\d+)"/g)].map(
    ([, appId]) => appId
  );

  return [...new Set(appIds)].filter((appId) => appId !== objectId);
};

const assetUrl = (item: SteamStoreItem, file: string | undefined) => {
  const format = item.assets?.asset_url_format;
  if (!format || !file) return null;

  return STEAM_ASSET_BASE_URL + format.replace("${FILENAME}", file);
};

// Keeps the page order; drops anything that is not a visible game.
export const toSteamRecommendations = (
  appIds: string[],
  items: SteamStoreItem[]
): SteamRecommendation[] => {
  const itemsById = new Map(items.map((item) => [String(item.appid), item]));

  return appIds.flatMap((objectId) => {
    const item = itemsById.get(objectId);
    if (!item?.name || item.success !== 1 || item.type !== 0) return [];

    return [
      {
        objectId,
        title: item.name,
        tagIds: (item.tagids ?? []).filter(Number.isInteger),
        coverImageUrl: assetUrl(
          item,
          item.assets?.library_capsule_2x ?? item.assets?.library_capsule
        ),
        libraryImageUrl: assetUrl(item, item.assets?.header),
      },
    ];
  });
};
