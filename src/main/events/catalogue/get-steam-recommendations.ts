import { getSteamRecommendations } from "@main/services";

import { registerEvent } from "../register-event";

registerEvent(
  "getSteamRecommendations",
  (_event: Electron.IpcMainInvokeEvent, objectId: string) =>
    getSteamRecommendations(objectId)
);
