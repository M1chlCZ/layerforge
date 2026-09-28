import sharp from "sharp";
import { displaceMaterialSurface, seamlessMaterialTile } from "seamless-texture/sharp";

const allowedBlends = new Map([
  ["normal", "over"],
  ["multiply", "multiply"],
  ["screen", "screen"],
  ["overlay", "overlay"],
  ["destination_in", "dest-in"],
]);

export const previewArtifactSpecs = Object.freeze([
  Object.freeze({ role: "card", mimeType: "image/avif", width: 320, height: 320 }),
  Object.freeze({ role: "card", mimeType: "image/webp", width: 320, height: 320 }),
  Object.freeze({ role: "detail", mimeType: "image/avif", width: 800, height: 800 }),
  Object.freeze({ role: "detail", mimeType: "image/webp", width: 800, height: 800 }),
  Object.freeze({ role: "zoom", mimeType: "image/avif", width: 1600, height: 1600 }),
  Object.freeze({ role: "zoom", mimeType: "image/webp", width: 1600, height: 1600 }),
]);

export const DEFAULT_ASSET_PREFIXES = Object.freeze(["/media/", "/cad/"]);

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const tokenPattern = /^[a-z][a-z0-9_]{0,62}$/;
const hashPattern = /^[0-9a-f]{64}$/i;
const colorPattern = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i;
const maxDimension = 6000;
const maxPixels = 16_000_000;
const maxAssetBytes = 16 * 1024 * 1024;
const maxCachedBytes = 32 * 1024 * 1024;

async function timed(options, stage, details, operation) {
  const started = performance.now();
  const result = await operation();
  options.onTiming?.({ stage, ...details, duration_ms: Math.round(performance.now() - started) });
  return result;
}

function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}

function safeAssetPath(value, assetPrefixes) {
  if (typeof value !== "string" || value.includes("\\") || value.includes("%")) return false;
  let parsed;
  try {
    parsed = new URL(value, "http://preview.invalid");
  } catch {
    return false;
  }
  return parsed.origin === "http://preview.invalid" &&
    parsed.pathname === value &&
    !parsed.search &&
    !parsed.hash &&
    !parsed.pathname.split("/").includes("..") &&
    assetPrefixes.some((prefix) => parsed.pathname.startsWith(prefix));
}

function optionalAsset(path, contentHash, label, assetPrefixes) {
  if (path === null && contentHash === null) return;
  if (!safeAssetPath(path, assetPrefixes) || typeof contentHash !== "string" || !hashPattern.test(contentHash)) {
    throw new Error(`invalid ${label}`);
  }
}

function materialTextureScale(candidate) {
  const value = candidate.material_texture_scale_millionths;
  if (candidate.material_texture_path === null) {
    if (value === undefined || value === null || value === 0) return 1_000_000;
    throw new Error("invalid material texture scale");
  }
  return integer(value ?? 1_000_000, 100_000, 8_000_000, "material texture scale");
}

function normalizeLayer(candidate, assetPrefixes) {
  if (candidate?.material_color_hex && !colorPattern.test(candidate.material_color_hex)) {
    throw new Error("invalid material color");
  }
  if (candidate?.material_texture_surface !== undefined &&
      (typeof candidate.material_texture_surface !== "boolean" ||
       (candidate.material_texture_surface && !candidate.material_texture_path))) {
    throw new Error("invalid material texture surface");
  }
  if (!candidate || typeof candidate !== "object" ||
      !uuidPattern.test(candidate.id) ||
      !tokenPattern.test(candidate.layer_key) ||
      !tokenPattern.test(candidate.role) ||
      !safeAssetPath(candidate.path, assetPrefixes) ||
      !hashPattern.test(candidate.content_hash) ||
      !allowedBlends.has(candidate.blend_mode)) {
    throw new Error("invalid layer");
  }
  if (candidate.shape_profile !== undefined && candidate.shape_profile !== null) {
    if (!tokenPattern.test(candidate.shape_profile)) throw new Error("invalid shape profile");
    integer(candidate.shape_width_mm, 1, 1000, "shape width");
  } else if (candidate.shape_width_mm !== undefined && candidate.shape_width_mm !== null) {
    throw new Error("invalid shape width");
  }
  optionalAsset(candidate.mask_path, candidate.mask_content_hash, "mask", assetPrefixes);
  optionalAsset(
    candidate.material_texture_path,
    candidate.material_texture_content_hash,
    "material texture",
    assetPrefixes,
  );
  return {
    ...candidate,
    material_texture_scale_millionths: materialTextureScale(candidate),
    opacity_basis_points: integer(candidate.opacity_basis_points, 0, 10_000, "opacity"),
    offset_x_micropixels: integer(
      candidate.offset_x_micropixels,
      -10_000_000_000,
      10_000_000_000,
      "x offset",
    ),
    offset_y_micropixels: integer(
      candidate.offset_y_micropixels,
      -10_000_000_000,
      10_000_000_000,
      "y offset",
    ),
    scale_x_millionths: integer(candidate.scale_x_millionths, 10_000, 100_000_000, "x scale"),
    scale_y_millionths: integer(candidate.scale_y_millionths, 10_000, 100_000_000, "y scale"),
    rotation_millidegrees: integer(candidate.rotation_millidegrees, -360_000, 360_000, "rotation"),
    z_order: integer(candidate.z_order, 0, 1_000_000, "z order"),
  };
}

/**
 * validateLayerManifest checks a layers_v2 manifest and returns a normalized
 * copy with layers sorted by z-order. Asset paths must sit under one of
 * options.assetPrefixes.
 */
export function validateLayerManifest(candidate, options = {}) {
  const assetPrefixes = options.assetPrefixes ?? DEFAULT_ASSET_PREFIXES;
  if (!Array.isArray(assetPrefixes) || assetPrefixes.length === 0 ||
      assetPrefixes.some((prefix) => typeof prefix !== "string" || !prefix.startsWith("/") || !prefix.endsWith("/"))) {
    throw new Error("invalid asset prefixes");
  }
  if (!candidate || typeof candidate !== "object" ||
      candidate.version !== 2 ||
      candidate.kind !== "layers_v2" ||
      !uuidPattern.test(candidate.revision_id) ||
      !candidate.output ||
      !colorPattern.test(candidate.output.background)) {
    throw new Error("invalid layers manifest");
  }
  const width = integer(candidate.output.width, 1, maxDimension, "output width");
  const height = integer(candidate.output.height, 1, maxDimension, "output height");
  if (width * height > maxPixels) throw new Error("output is too large");
  if (!Array.isArray(candidate.layers) || candidate.layers.length < 1 || candidate.layers.length > 128) {
    throw new Error("invalid layer count");
  }
  const layers = candidate.layers.map((item) => normalizeLayer(item, assetPrefixes));
  const ids = new Set();
  const keys = new Set();
  for (const layer of layers) {
    if (ids.has(layer.id) || keys.has(layer.layer_key)) throw new Error("duplicate layer");
    ids.add(layer.id);
    keys.add(layer.layer_key);
  }
  layers.sort((left, right) =>
    left.z_order - right.z_order ||
    left.layer_key.localeCompare(right.layer_key) ||
    left.id.localeCompare(right.id));
  return {
    version: 2,
    kind: "layers_v2",
    revision_id: candidate.revision_id,
    output: { width, height, background: candidate.output.background.toUpperCase() },
    layers,
  };
}

function parseBackground(value) {
  const alpha = value.length === 9
    ? Number.parseInt(value.slice(7, 9), 16) / 255
    : 1;
  return {
    r: Number.parseInt(value.slice(1, 3), 16),
    g: Number.parseInt(value.slice(3, 5), 16),
    b: Number.parseInt(value.slice(5, 7), 16),
    alpha,
  };
}

function remoteAssetLoader(assetOrigin, assetPrefixes) {
  const allowedOrigin = new URL(assetOrigin);
  return async (assetPath, signal) => {
    if (!safeAssetPath(assetPath, assetPrefixes)) throw new Error("unsafe asset path");
    const target = new URL(assetPath, allowedOrigin);
    if (target.origin !== allowedOrigin.origin) throw new Error("unsafe asset origin");
    const response = await fetch(target, {
      redirect: "error",
      signal,
      headers: { Accept: "image/png,image/webp,image/avif" },
    });
    if (!response.ok) throw new Error("asset request failed");
    const declaredLength = Number.parseInt(response.headers.get("content-length") ?? "0", 10);
    if (declaredLength > maxAssetBytes) throw new Error("asset is too large");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > maxAssetBytes) throw new Error("invalid asset size");
    return bytes;
  };
}

async function shapedLayer(source, layer, shapes) {
  if (!layer.shape_profile) return source;
  const handler = shapes[layer.shape_profile];
  if (typeof handler !== "function") {
    throw new Error(`unknown shape profile: ${layer.shape_profile}`);
  }
  const shaped = await handler(source, { widthMm: layer.shape_width_mm, layer });
  if (!Buffer.isBuffer(shaped) || shaped.length === 0) {
    throw new Error(`invalid shape result: ${layer.shape_profile}`);
  }
  return shaped;
}

async function maskedOrTexturedLayer(layer, loadAsset, shapes, signal) {
  const source = await loadAsset(layer.path, signal);
  const sourceMetadata = await sharp(source, { limitInputPixels: maxPixels }).metadata();
  if (!sourceMetadata.width || !sourceMetadata.height) throw new Error("layer dimensions are unavailable");
  let image = await shapedLayer(source, layer, shapes);

  if (!layer.shape_profile && layer.material_color_hex && !layer.material_texture_path) {
    image = await sharp({ create: {
      width: sourceMetadata.width, height: sourceMetadata.height,
      channels: 4, background: layer.material_color_hex,
    } }).composite([{ input: source, blend: "dest-in" }]).png({ compressionLevel: 0 }).toBuffer();
  }

  if (layer.material_texture_path) {
    const originalTexture = await loadAsset(layer.material_texture_path, signal);
    const texture = layer.material_texture_surface
      ? await seamlessMaterialTile(originalTexture)
      : originalTexture;
    const textureMetadata = await sharp(texture, { limitInputPixels: maxPixels }).metadata();
    if (!textureMetadata.width || !textureMetadata.height) {
      throw new Error("material texture dimensions are unavailable");
    }
    const textureWidth = Math.max(1, Math.round(
      textureMetadata.width * layer.material_texture_scale_millionths / 1_000_000,
    ));
    const textureHeight = Math.max(1, Math.round(
      textureMetadata.height * layer.material_texture_scale_millionths / 1_000_000,
    ));
    if (textureWidth * textureHeight > maxPixels) throw new Error("material texture is too large");
    let scaledTexture = layer.material_texture_scale_millionths === 1_000_000
      ? texture
      : await sharp(texture, { limitInputPixels: maxPixels })
        .resize(textureWidth, textureHeight, { fit: "fill", kernel: sharp.kernel.lanczos3 })
        .png({ compressionLevel: 0 })
        .toBuffer();
    if (textureWidth > sourceMetadata.width || textureHeight > sourceMetadata.height) {
      const width = Math.min(textureWidth, sourceMetadata.width);
      const height = Math.min(textureHeight, sourceMetadata.height);
      scaledTexture = await sharp(scaledTexture, { limitInputPixels: maxPixels }).extract({
        left: Math.floor((textureWidth - width) / 2),
        top: Math.floor((textureHeight - height) / 2),
        width,
        height,
      }).png({ compressionLevel: 0 }).toBuffer();
    }
    let tiled = await sharp({
      create: {
        width: sourceMetadata.width,
        height: sourceMetadata.height,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    }).composite([{ input: scaledTexture, tile: true, blend: "over" }]).png({ compressionLevel: 0 }).toBuffer();
    if (layer.material_texture_surface) {
      tiled = await displaceMaterialSurface(tiled, source, sourceMetadata.width, sourceMetadata.height);
    }
    image = await sharp(tiled).composite([{ input: source, blend: "dest-in" }]).png({ compressionLevel: 0 }).toBuffer();
  }

  if (layer.mask_path) {
    const mask = await loadAsset(layer.mask_path, signal);
    const resizedMask = await sharp(mask, { limitInputPixels: maxPixels })
      .ensureAlpha()
      .resize(sourceMetadata.width, sourceMetadata.height, { fit: "fill" })
      .png({ compressionLevel: 0 })
      .toBuffer();
    image = await sharp(image)
      .composite([{ input: resizedMask, blend: "dest-in" }])
      .png({ compressionLevel: 0 })
      .toBuffer();
  }

  const opacity = layer.opacity_basis_points / 10_000;
  if (opacity < 1) {
    image = await sharp(image)
      .ensureAlpha()
      .linear([1, 1, 1, opacity], [0, 0, 0, 0])
      .png({ compressionLevel: 0 })
      .toBuffer();
  }
  return image;
}

async function transformLayer(image, layer) {
  const metadata = await sharp(image, { limitInputPixels: maxPixels }).metadata();
  if (!metadata.width || !metadata.height) throw new Error("layer dimensions are unavailable");
  const width = Math.max(1, Math.round(metadata.width * layer.scale_x_millionths / 1_000_000));
  const height = Math.max(1, Math.round(metadata.height * layer.scale_y_millionths / 1_000_000));
  const angle = Math.abs(layer.rotation_millidegrees % 180_000);
  const radians = angle * Math.PI / 180_000;
  const cosine = Math.abs(Math.cos(radians));
  const sine = Math.abs(Math.sin(radians));
  const rotatedWidth = angle === 0 ? width : angle === 90_000 ? height :
    Math.ceil(width * cosine + height * sine);
  const rotatedHeight = angle === 0 ? height : angle === 90_000 ? width :
    Math.ceil(width * sine + height * cosine);
  if (width > maxDimension || height > maxDimension || width * height > maxPixels ||
      rotatedWidth > maxDimension || rotatedHeight > maxDimension ||
      rotatedWidth * rotatedHeight > maxPixels) {
    throw new Error("transformed layer is too large");
  }
  if (layer.scale_x_millionths === 1_000_000 && layer.scale_y_millionths === 1_000_000 &&
      layer.rotation_millidegrees === 0) return { data: image, info: metadata };
  let pipeline = sharp(image, { limitInputPixels: maxPixels })
    .resize(width, height, { fit: "fill", kernel: sharp.kernel.lanczos3 });
  if (layer.rotation_millidegrees !== 0) {
    pipeline = pipeline.rotate(layer.rotation_millidegrees / 1000, {
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    });
  }
  return pipeline.png({ compressionLevel: 0 }).toBuffer({ resolveWithObject: true });
}

async function placeOnCanvas(image, layer, output) {
  const transformed = await transformLayer(image, layer);
  const offsetX = Math.round(layer.offset_x_micropixels / 1_000_000);
  const offsetY = Math.round(layer.offset_y_micropixels / 1_000_000);
  if (offsetX === 0 && offsetY === 0 && transformed.info.width === output.width &&
      transformed.info.height === output.height) return transformed.data;
  const desiredLeft = Math.round((output.width - transformed.info.width) / 2 + offsetX);
  const desiredTop = Math.round((output.height - transformed.info.height) / 2 + offsetY);
  const sourceLeft = Math.max(0, -desiredLeft);
  const sourceTop = Math.max(0, -desiredTop);
  const targetLeft = Math.max(0, desiredLeft);
  const targetTop = Math.max(0, desiredTop);
  const width = Math.min(
    transformed.info.width - sourceLeft,
    output.width - targetLeft,
  );
  const height = Math.min(
    transformed.info.height - sourceTop,
    output.height - targetTop,
  );
  if (width <= 0 || height <= 0) {
    return sharp({
      create: {
        width: output.width,
        height: output.height,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    }).png({ compressionLevel: 0 }).toBuffer();
  }
  const visible = sourceLeft || sourceTop ||
      width !== transformed.info.width || height !== transformed.info.height
    ? await sharp(transformed.data).extract({ left: sourceLeft, top: sourceTop, width, height }).png({ compressionLevel: 0 }).toBuffer()
    : transformed.data;
  return sharp({
    create: {
      width: output.width,
      height: output.height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  }).composite([{ input: visible, left: targetLeft, top: targetTop }]).png({ compressionLevel: 0 }).toBuffer();
}

async function renderValidatedLayerManifest(manifest, options = {}) {
  const shapes = options.shapes ?? {};
  const assetPrefixes = options.assetPrefixes ?? DEFAULT_ASSET_PREFIXES;
  const fetchAsset = options.loadAsset ??
    (options.assetOrigin ? remoteAssetLoader(options.assetOrigin, assetPrefixes) : null);
  if (!fetchAsset) throw new Error("an asset origin or loader is required");
  const assets = new Map();
  let cachedBytes = 0;
  const loadAsset = async (path, signal) => {
    if (assets.has(path)) return assets.get(path);
    const bytes = await fetchAsset(path, signal);
    if (cachedBytes + bytes.length <= maxCachedBytes) {
      assets.set(path, bytes);
      cachedBytes += bytes.length;
    }
    return bytes;
  };
  const signal = options.signal;
  let output = await sharp({
    create: {
      width: manifest.output.width,
      height: manifest.output.height,
      channels: 4,
      background: parseBackground(manifest.output.background),
    },
  }).png({ compressionLevel: 0 }).toBuffer();

  const batchLimit = Math.max(1, Math.floor(maxCachedBytes /
    (manifest.output.width * manifest.output.height * 4)));
  let overlays = [];
  const compositeBatch = async () => {
    output = await timed(options, "composite_layers", { layers: overlays.length }, () => sharp(output)
      .composite(overlays)
      .png({ compressionLevel: 0 })
      .toBuffer());
    overlays = [];
  };
  for (const layer of manifest.layers) {
    const details = { layer: layer.layer_key };
    const prepared = await timed(options, "prepare_layer", details,
      () => maskedOrTexturedLayer(layer, loadAsset, shapes, signal));
    const placed = await timed(options, "place_layer", details,
      () => placeOnCanvas(prepared, layer, manifest.output));
    overlays.push({ input: placed, blend: allowedBlends.get(layer.blend_mode) });
    if (overlays.length >= batchLimit) await compositeBatch();
  }
  if (overlays.length) await compositeBatch();

  return output;
}

/**
 * renderLayerManifest composites a layers_v2 manifest and returns a lossless
 * WebP master. options.shapes maps a shape profile to an async handler.
 */
export async function renderLayerManifest(candidate, options = {}) {
  const master = await renderValidatedLayerManifest(validateLayerManifest(candidate, options), options);
  return sharp(master).webp({ lossless: true, effort: 6 }).toBuffer();
}

/**
 * renderLayerArtifactSet renders the master and returns one AVIF and one WebP
 * file for each responsive role.
 */
export async function renderLayerArtifactSet(candidate, options = {}) {
  const manifest = validateLayerManifest(candidate, options);
  const master = await timed(options, "master", {}, () => renderValidatedLayerManifest(manifest, options));
  const background = parseBackground(manifest.output.background);
  return Promise.all(previewArtifactSpecs.map(async (spec) => {
    const pipeline = sharp(master, { limitInputPixels: maxPixels }).resize({
      width: spec.width,
      height: spec.height,
      fit: "contain",
      background,
      kernel: sharp.kernel.lanczos3,
    });
    const contents = await timed(options, "artifact", { role: spec.role, format: spec.mimeType }, () => spec.mimeType === "image/avif"
      ? pipeline.avif({
        quality: 82,
        effort: 0,
        chromaSubsampling: "4:4:4",
      }).toBuffer()
      : pipeline.webp({
        quality: 90,
        effort: 0,
        smartSubsample: false,
      }).toBuffer());
    if (contents.length === 0 || contents.length > maxAssetBytes) {
      throw new Error("rendered artifact is too large");
    }
    return { ...spec, contents };
  }));
}
