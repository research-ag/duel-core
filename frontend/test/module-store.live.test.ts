import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fetchGameModule, readModuleHash } from "../src/module-store-node.js";

// Against mainnet, opt-in: DUEL_HOSTY_CANISTER=<id of a game installed
// through hosty.live> npm test
const id = process.env.DUEL_HOSTY_CANISTER;

test("live: the store serves the module the canister runs", { skip: !id && "DUEL_HOSTY_CANISTER not set" }, async () => {
  const live = await readModuleHash(id!);
  assert.ok(live, `${id} has no module`);
  const m = await fetchGameModule(id!);
  assert.equal(m.hash, live);
  assert.equal(createHash("sha256").update(m.bytes).digest("hex"), live);
});
