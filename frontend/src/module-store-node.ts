// Node only: `fetchGameModule` with a download that keeps the body as
// sent, so a gzipped module still hashes to its store key. See README,
// "Fetching a game's module".

import { get } from "node:https";

import {
  fetchGameModule as fetchWith,
  type Download,
  type FetchGameModuleOptions,
  type GameModule,
} from "./module-store.js";

export * from "./module-store.js";

export const rawDownload: Download = (url) =>
  new Promise((resolve, reject) => {
    get(
      url,
      { headers: { "user-agent": "Mozilla/5.0 (duel-game-core)", "accept-encoding": "identity" } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const enc = res.headers["content-encoding"];
          resolve({
            status: res.statusCode ?? 0,
            bytes: new Uint8Array(Buffer.concat(chunks)),
            contentEncoding: typeof enc === "string" ? enc : null,
          });
        });
        res.on("error", reject);
      },
    ).on("error", reject);
  });

export function fetchGameModule(
  canisterId: string,
  opts: FetchGameModuleOptions = {},
): Promise<GameModule> {
  return fetchWith(canisterId, { download: rawDownload, ...opts });
}
