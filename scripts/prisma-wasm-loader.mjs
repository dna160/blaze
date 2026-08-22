/**
 * Node module-customization hook that lets Prisma's generated `wasm.js`
 * client run under plain Node — for sandboxes where binaries.prisma.sh is
 * unreachable and the native query engine can't be downloaded.
 *
 * The generated client's `#wasm-engine-loader` does `import('./query_engine_bg.wasm')`
 * and expects the module's default export to be a compiled
 * `WebAssembly.Module` (the Cloudflare Workers / edge-light contract). Node
 * has no such loader, so this hook compiles the .wasm bytes and exports the
 * Module as `default`.
 *
 * Usage (opt-in, never set in production):
 *   NODE_OPTIONS="--import /abs/path/scripts/prisma-wasm-loader.mjs" PRISMA_DRIVER_ADAPTER=pg node ...
 *
 * Pair with PRISMA_DRIVER_ADAPTER=pg (see packages/database/src/client.ts),
 * which swaps the native library engine for the pg driver adapter.
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register(
  "data:text/javascript," +
    encodeURIComponent(`
      import { readFileSync } from "node:fs";
      import { fileURLToPath } from "node:url";
      export async function load(url, context, nextLoad) {
        if (url.endsWith(".wasm") || url.includes(".wasm?")) {
          const path = fileURLToPath(url.split("?")[0]);
          const bytes = readFileSync(path);
          const b64 = bytes.toString("base64");
          return {
            format: "module",
            shortCircuit: true,
            source: 'const bytes = Buffer.from("' + b64 + '", "base64"); export default await WebAssembly.compile(bytes);',
          };
        }
        return nextLoad(url, context);
      }
    `),
  pathToFileURL("./"),
);
