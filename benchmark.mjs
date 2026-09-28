// Run in the renderer image. Pipe a layers_v2 manifest to stdin and set
// ASSET_ORIGIN. BENCHMARK_CODECS=1 compares encoder effort, size, and RGB error.
import sharp from "sharp";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { previewArtifactSpecs, renderLayerArtifactSet, renderLayerManifest } from "./src/index.mjs";
import { loadShapes } from "./src/server.mjs";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const manifest = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const options = {
  assetOrigin: process.env.ASSET_ORIGIN,
  shapes: await loadShapes(process.env.SHAPES_MODULE ?? null),
};
if (!options.assetOrigin) throw new Error("ASSET_ORIGIN is required");
const runs = Number(process.env.BENCHMARK_RUNS ?? 3);
if (!Number.isInteger(runs) || runs < 1 || runs > 10) throw new Error("invalid run count");
for (let run = 1; run <= runs; run++) {
  const timings = [];
  const start = performance.now();
  const artifacts = await renderLayerArtifactSet(manifest, {
    ...options,
    onTiming: (event) => timings.push(event),
  });
  console.log(JSON.stringify({ run, total_ms: Math.round(performance.now() - start), timings,
    sizes: artifacts.map(({ role, mimeType, contents }) => ({ role, mimeType, bytes: contents.length })) }));
}

if (process.env.BENCHMARK_CODECS === "1" || process.env.BENCHMARK_ENCODER_TUNING === "1") {
  const master = await renderLayerManifest(manifest, options);
  for (const spec of previewArtifactSpecs.filter((item) => item.role !== "card")) {
    const reference = await sharp(master).resize({ width: spec.width, height: spec.height,
      fit: "contain", background: manifest.output.background }).ensureAlpha().raw().toBuffer();
    const settings = process.env.BENCHMARK_ENCODER_TUNING === "1"
      ? spec.mimeType === "image/avif"
        ? [{ effort: 0, quality: 82, chromaSubsampling: "4:4:4" }]
        : [
          { quality: 90, effort: 1, smartSubsample: true },
          { quality: 90, effort: 0, smartSubsample: false },
          { lossless: true, effort: 0 },
        ]
      : spec.mimeType === "image/avif"
        ? [2, 0].map((effort) => ({ quality: 82, effort, chromaSubsampling: "4:4:4" }))
        : [5, 1].map((effort) => ({ quality: 90, effort, smartSubsample: true }));
    for (const encodeOptions of settings) {
      const start = performance.now();
      const pipeline = sharp(reference, { raw: { width: spec.width, height: spec.height, channels: 4 } });
      const encoded = await (spec.mimeType === "image/avif"
        ? pipeline.avif(encodeOptions)
        : pipeline.webp(encodeOptions)).toBuffer();
      const duration_ms = Math.round(performance.now() - start);
      const decoded = await sharp(encoded).ensureAlpha().raw().toBuffer();
      let squaredError = 0, samples = 0;
      for (let index = 0; index < reference.length; index += 4) {
        if (reference[index + 3] < 128) continue;
        for (let channel = 0; channel < 3; channel++) {
          squaredError += (decoded[index + channel] - reference[index + channel]) ** 2;
          samples++;
        }
      }
      console.log(JSON.stringify({ codec: spec.mimeType, role: spec.role, options: encodeOptions,
        duration_ms, bytes: encoded.length, rgb_rmse: Math.sqrt(squaredError / samples) }));
    }
  }
}

if (process.env.BASELINE_RENDERER) {
  const baseline = await import(process.env.BASELINE_RENDERER);
  const before = await baseline.renderLayerManifest(manifest, options);
  const after = await renderLayerManifest(manifest, options);
  const left = await sharp(before).ensureAlpha().raw().toBuffer();
  const right = await sharp(after).ensureAlpha().raw().toBuffer();
  if (left.length !== right.length) throw new Error("master dimensions changed");
  let squaredError = 0, maxError = 0;
  for (let index = 0; index < left.length; index++) {
    const error = Math.abs(left[index] - right[index]);
    squaredError += error ** 2;
    maxError = Math.max(maxError, error);
  }
  console.log(JSON.stringify({ master_rgba_rmse: Math.sqrt(squaredError / left.length), max_error: maxError }));
  if (process.env.BENCHMARK_OUTPUT_DIR) {
    await mkdir(process.env.BENCHMARK_OUTPUT_DIR, { recursive: true });
    await writeFile(join(process.env.BENCHMARK_OUTPUT_DIR, "before.webp"), before);
    await writeFile(join(process.env.BENCHMARK_OUTPUT_DIR, "after.webp"), after);
  }
}
