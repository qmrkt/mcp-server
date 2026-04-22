#!/usr/bin/env node
// Pull the latest deployment JSONs from @questionmarket/sdk into this repo's
// deployments/ directory. Run after the SDK republishes testnet/mainnet IDs.
//
// Sources tried in order:
//   1. Explicit --sdk=<path> argument
//   2. node_modules/@questionmarket/sdk/protocol-deployment.<network>.json
//   3. ../sdk/protocol-deployment.<network>.json (monorepo layout)
//   4. ../question-sdk/protocol-deployment.<network>.json (peer checkout)

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "deployments");
fs.mkdirSync(outDir, { recursive: true });

const explicit = process.argv.find((arg) => arg.startsWith("--sdk="))?.slice("--sdk=".length);

function sdkRoots() {
  const roots = [];
  if (explicit) roots.push(path.resolve(explicit));
  roots.push(path.resolve(root, "node_modules/@questionmarket/sdk"));
  roots.push(path.resolve(root, "..", "sdk"));
  roots.push(path.resolve(root, "..", "question-sdk"));
  return roots.filter((p) => fs.existsSync(p));
}

const roots = sdkRoots();
if (roots.length === 0) {
  console.error("[sync] could not locate @questionmarket/sdk. Try --sdk=/path/to/sdk");
  process.exit(1);
}

const networks = ["testnet", "mainnet"];
let copied = 0;
for (const network of networks) {
  for (const sdkRoot of roots) {
    const src = path.join(sdkRoot, `protocol-deployment.${network}.json`);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(outDir, `${network}.json`);
    fs.copyFileSync(src, dest);
    console.error(`[sync] ${network}: ${src} -> ${path.relative(root, dest)}`);
    copied++;
    break;
  }
}

if (copied === 0) {
  console.error("[sync] no deployment files found in any SDK root");
  process.exit(1);
}
