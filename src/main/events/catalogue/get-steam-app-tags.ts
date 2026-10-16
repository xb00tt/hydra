import { getSteamAppTags } from "@main/services";

import { registerEvent } from "../register-event";

registerEvent(
  "getSteamAppTags",
  (_event: Electron.IpcMainInvokeEvent, objectId: string) =>
    getSteamAppTags(objectId)
);
