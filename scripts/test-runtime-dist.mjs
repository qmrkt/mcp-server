import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const distIndexPath = path.resolve(root, "dist/index.js");
const distServerPath = path.resolve(root, "dist/server.js");

const indexSource = await readFile(distIndexPath, "utf8");
if (!indexSource.startsWith("#!/usr/bin/env node")) {
  throw new Error("dist/index.js is missing the CLI shebang");
}

const indexModule = await import(pathToFileURL(distIndexPath).href);
const serverModule = await import(pathToFileURL(distServerPath).href);

if (typeof indexModule.main !== "function") {
  throw new Error("dist/index.js does not export main()");
}

if (typeof serverModule.createQuestionMarketServer !== "function") {
  throw new Error("dist/server.js does not export createQuestionMarketServer()");
}
