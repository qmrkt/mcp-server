import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version?: string };

export const MCP_SERVER_VERSION = packageJson.version ?? "0.1.0";
