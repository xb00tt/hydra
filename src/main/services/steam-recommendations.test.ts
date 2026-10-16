import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parseMoreLikeAppIds,
  toSteamRecommendations,
} from "./steam-recommendations.js";

const capsule = (appId: string) =>
  `<a class="similar_grid_capsule" data-ds-appid="${appId}"></a>`;

describe("parseMoreLikeAppIds", () => {
  it("reads only the first grid, skipping the game itself and repeats", () => {
    const html = [
      `<div class="pageheader">${capsule("100")}</div>`,
      `<div class="recommendation_area_ctn similar_grid_ctn">`,
      capsule("1"),
      capsule("100"),
      capsule("2"),
      capsule("1"),
      `<a data-ds-appid="3,4"></a>`,
      `<h2 class="morelike_section_divider">Upcoming Releases</h2>`,
      `<div class="recommendation_area_ctn similar_grid_ctn">`,
      capsule("5"),
    ].join("\n");

    assert.deepEqual(parseMoreLikeAppIds(html, "100"), ["1", "2"]);
  });

  it("returns nothing for a page without a grid", () => {
    assert.deepEqual(parseMoreLikeAppIds("<html>agecheck</html>", "1"), []);
  });
});

describe("toSteamRecommendations", () => {
  const assets = {
    asset_url_format: "steam/apps/1/${FILENAME}?t=9",
    library_capsule_2x: "abc/library_600x900_2x.jpg",
    header: "def/header.jpg",
  };

  it("keeps the page order and builds artwork urls", () => {
    const results = toSteamRecommendations(
      ["2", "1"],
      [
        { appid: 1, success: 1, type: 0, name: "One", tagids: [5], assets },
        { appid: 2, success: 1, type: 0, name: "Two" },
      ]
    );

    assert.deepEqual(results, [
      {
        objectId: "2",
        title: "Two",
        tagIds: [],
        coverImageUrl: null,
        libraryImageUrl: null,
      },
      {
        objectId: "1",
        title: "One",
        tagIds: [5],
        coverImageUrl:
          "https://shared.steamstatic.com/store_item_assets/steam/apps/1/abc/library_600x900_2x.jpg?t=9",
        libraryImageUrl:
          "https://shared.steamstatic.com/store_item_assets/steam/apps/1/def/header.jpg?t=9",
      },
    ]);
  });

  it("drops missing, failed, nameless and non-game items", () => {
    const results = toSteamRecommendations(
      ["1", "2", "3", "4"],
      [
        { appid: 2, success: 15, type: 0, name: "Failed" },
        { appid: 3, success: 1, type: 4, name: "DLC" },
        { appid: 4, success: 1, type: 0, name: "" },
      ]
    );

    assert.deepEqual(results, []);
  });
});
