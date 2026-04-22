#!/usr/bin/env node
// Copy committed deployment JSONs from mcp-server/deployments/ into dist/
// so the published npm package ships them. Invoked during build.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const srcDir = path.join(root, "deployments");
const outDir = path.join(root, "dist", "deployments");

if (!fs.existsSync(srcDir)) {
  console.error(`[mcp-build] warning: ${srcDir} does not exist; skipping deployment bundling`);
  process.exit(0);
}

fs.mkdirSync(outDir, { recursive: true });

const files = fs.readdirSync(srcDir).filter((name) => name.endsWith(".json"));
if (files.length === 0) {
  console.error(`[mcp-build] warning: no deployment JSONs found in ${srcDir}`);
  process.exit(0);
}

for (const name of files) {
  fs.copyFileSync(path.join(srcDir, name), path.join(outDir, name));
  console.error(`[mcp-build] bundled ${name}`);
}
