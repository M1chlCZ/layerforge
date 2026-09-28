#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { renderLayerArtifactSet } from "./index.mjs";
import { loadShapes, startServer } from "./server.mjs";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const usage = `Usage: layerforge <command> [options]

Commands:
  render <manifest.json> --out DIR   Write the responsive preview files
  serve                              Start the render HTTP service

Options:
  --asset-origin URL   Origin for the media and cad asset paths
  --shapes FILE        Module that exports a shapes object
  --out DIR            Output directory for the render command
  --port N             Service port (default 3100)
  -h, --help           Show this help
  -v, --version        Show the version`;

async function renderCommand(manifestPath, values, assetOrigin, shapesModule) {
  if (!manifestPath || !values.out) {
    throw new Error("usage: layerforge render <manifest.json> --out DIR");
  }
  if (!assetOrigin) throw new Error("--asset-origin or ASSET_ORIGIN is required");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const shapes = await loadShapes(shapesModule);
  const artifacts = await renderLayerArtifactSet(manifest, { assetOrigin, shapes });
  await mkdir(values.out, { recursive: true });
  for (const artifact of artifacts) {
    const extension = artifact.mimeType === "image/avif" ? "avif" : "webp";
    const name = `${artifact.role}-${artifact.width}.${extension}`;
    await writeFile(join(values.out, name), artifact.contents);
    process.stdout.write(`${name} ${artifact.contents.length}\n`);
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      out: { type: "string" },
      "asset-origin": { type: "string" },
      shapes: { type: "string" },
      port: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
    allowPositionals: true,
    strict: true,
  });
  if (values.version) {
    process.stdout.write(`${version}\n`);
    return;
  }
  if (values.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  const [command, manifestPath] = positionals;
  const assetOrigin = values["asset-origin"] ?? process.env.ASSET_ORIGIN;
  const shapesModule = values.shapes ?? process.env.SHAPES_MODULE ?? null;
  switch (command) {
    case "render":
      return renderCommand(manifestPath, values, assetOrigin, shapesModule);
    case "serve": {
      if (!assetOrigin) throw new Error("--asset-origin or ASSET_ORIGIN is required");
      const port = Number.parseInt(values.port ?? process.env.PORT ?? "3100", 10);
      startServer({ port, assetOrigin, shapesModule });
      return;
    }
    default:
      throw new Error(usage);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
