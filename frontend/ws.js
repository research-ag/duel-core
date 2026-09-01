// The real-time push transport — the only one `start()` supports; there
// is no plain-polling mode any more. No Gateway process and no
// `ic-websocket-js` dependency here — the actual work is one small poller
// in `./ws/poller.js`, kept in its own directory since it's a
// self-contained little library in its own right (not a one-off helper
// like `ic-env.js`). This file is just the stable public entry point, so
// `duel-game-core/ws.js` keeps meaning the same thing it always has.
//
// Usage:
//
//   import { connectWs } from "duel-game-core/ws.js";
//   const ws = connectWs({ actor });
//   start({ plugin, ws });

export { connectWs, PollingWs } from "./ws/poller.js";
