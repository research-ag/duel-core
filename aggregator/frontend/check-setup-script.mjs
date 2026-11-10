// Fails when cloudSession.ts's SETUP_SCRIPT and cloud-session.md's setup
// script differ.

import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

const ts = read("./src/cloudSession.ts").match(
  /export const SETUP_SCRIPT = `([\s\S]*?)`;/
)?.[1];

const block = read(
  "../../skills/duel-game-core/references/cloud-session.md"
).match(
  /^( *)```bash\n((?:(?!```)[\s\S])*?icp-cli-network-launcher[\s\S]*?)\n\1```[ \t]*$/m
);
const md = block?.[2]
  .split("\n")
  .map((line) => line.slice(block[1].length))
  .join("\n");

if (!ts || !md) {
  console.error(
    "setup script not found in cloudSession.ts or cloud-session.md"
  );
  process.exit(1);
}
if (ts !== md) {
  console.error("SETUP_SCRIPT differs from cloud-session.md's setup script");
  process.exit(1);
}
console.log("setup script in sync");
