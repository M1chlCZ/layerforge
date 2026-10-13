export const DEFAULT_ASSET_PREFIXES = Object.freeze(["/media/", "/cad/"]);

export const allowedBlends = new Map([
  ["normal", "over"],
  ["multiply", "multiply"],
  ["screen", "screen"],
  ["overlay", "overlay"],
  ["destination_in", "dest-in"],
]);

export const maxDimension = 6000;

export const maxPixels = 16_000_000;

const maxLayerCount = 128;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const tokenPattern = /^[a-z][a-z0-9_]{0,62}$/;
const hashPattern = /^[0-9a-f]{64}$/i;
const colorPattern = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i;

function integerInRange(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

export function safeAssetPath(value, assetPrefixes) {
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

function inspectAssetPair(errors, layer, base, label, assetPrefixes) {
  const pathKey = `${label}_path`;
  const hashKey = `${label}_content_hash`;
  const hasPath = Object.hasOwn(layer, pathKey);
  const hasHash = Object.hasOwn(layer, hashKey);
  if (!hasPath) errors.push({ path: `${base}/${pathKey}`, message: "is required" });
  if (!hasHash) errors.push({ path: `${base}/${hashKey}`, message: "is required" });
  if (!hasPath || !hasHash) return;
  const path = layer[pathKey];
  const hash = layer[hashKey];
  if (path === null && hash === null) return;
  if (path === null) {
    errors.push({ path: `${base}/${hashKey}`, message: `must be null when ${pathKey} is null` });
    return;
  }
  if (!safeAssetPath(path, assetPrefixes)) {
    errors.push({ path: `${base}/${pathKey}`, message: `must be a safe asset path under ${assetPrefixes.join(", ")}` });
  }
  if (!hashPattern.test(hash)) {
    errors.push({ path: `${base}/${hashKey}`, message: "must be a 64-character hex string" });
  }
}

function inspectLayer(candidate, index, assetPrefixes) {
  const errors = [];
  const base = `/layers/${index}`;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return [{ path: base, message: "must be an object" }];
  }
  const push = (property, message) => errors.push({ path: `${base}/${property}`, message });
  if (!uuidPattern.test(candidate.id)) push("id", "must be a UUID");
  if (typeof candidate.layer_key !== "string" || !tokenPattern.test(candidate.layer_key)) {
    push("layer_key", "must be a lowercase token");
  }
  if (typeof candidate.role !== "string" || !tokenPattern.test(candidate.role)) {
    push("role", "must be a lowercase token");
  }
  if (!safeAssetPath(candidate.path, assetPrefixes)) {
    push("path", `must be a safe asset path under ${assetPrefixes.join(", ")}`);
  }
  if (!hashPattern.test(candidate.content_hash)) push("content_hash", "must be a 64-character hex string");
  if (!allowedBlends.has(candidate.blend_mode)) {
    push("blend_mode", `must be one of ${[...allowedBlends.keys()].join(", ")}`);
  }
  inspectAssetPair(errors, candidate, base, "mask", assetPrefixes);
  if (candidate.material_color_hex && !colorPattern.test(candidate.material_color_hex)) {
    push("material_color_hex", "must be a hex color like #RRGGBB");
  }
  if (candidate.material_texture_surface !== undefined &&
      typeof candidate.material_texture_surface !== "boolean") {
    push("material_texture_surface", "must be a boolean");
  } else if (candidate.material_texture_surface === true && !candidate.material_texture_path) {
    push("material_texture_surface", "requires material_texture_path");
  }
  if (candidate.material_texture_path === null) {
    const scale = candidate.material_texture_scale_millionths;
    if (scale !== undefined && scale !== null && scale !== 0) {
      push("material_texture_scale_millionths", "must be 0, null, or absent without a material texture");
    }
  } else if (candidate.material_texture_scale_millionths !== undefined &&
             candidate.material_texture_scale_millionths !== null &&
             !integerInRange(candidate.material_texture_scale_millionths, 100_000, 8_000_000)) {
    push("material_texture_scale_millionths", "must be an integer between 100000 and 8000000");
  }
  inspectAssetPair(errors, candidate, base, "material_texture", assetPrefixes);
  const hasShapeProfile = candidate.shape_profile !== undefined && candidate.shape_profile !== null;
  if (hasShapeProfile && (typeof candidate.shape_profile !== "string" ||
      !tokenPattern.test(candidate.shape_profile))) {
    push("shape_profile", "must be a lowercase token");
  }
  if (hasShapeProfile) {
    if (!integerInRange(candidate.shape_width_mm, 1, 1000)) {
      push("shape_width_mm", "must be an integer between 1 and 1000 when shape_profile is set");
    }
  } else if (candidate.shape_width_mm !== undefined && candidate.shape_width_mm !== null) {
    push("shape_width_mm", "must be null when shape_profile is not set");
  }
  if (!integerInRange(candidate.opacity_basis_points, 0, 10_000)) {
    push("opacity_basis_points", "must be an integer between 0 and 10000");
  }
  if (!integerInRange(candidate.offset_x_micropixels, -10_000_000_000, 10_000_000_000)) {
    push("offset_x_micropixels", "must be an integer between -10000000000 and 10000000000");
  }
  if (!integerInRange(candidate.offset_y_micropixels, -10_000_000_000, 10_000_000_000)) {
    push("offset_y_micropixels", "must be an integer between -10000000000 and 10000000000");
  }
  if (!integerInRange(candidate.scale_x_millionths, 10_000, 100_000_000)) {
    push("scale_x_millionths", "must be an integer between 10000 and 100000000");
  }
  if (!integerInRange(candidate.scale_y_millionths, 10_000, 100_000_000)) {
    push("scale_y_millionths", "must be an integer between 10000 and 100000000");
  }
  if (!integerInRange(candidate.rotation_millidegrees, -360_000, 360_000)) {
    push("rotation_millidegrees", "must be an integer between -360000 and 360000");
  }
  if (!integerInRange(candidate.z_order, 0, 1_000_000)) {
    push("z_order", "must be an integer between 0 and 1000000");
  }
  return errors;
}

function inspectLayerManifest(candidate, options) {
  const assetPrefixes = options.assetPrefixes ?? DEFAULT_ASSET_PREFIXES;
  if (!Array.isArray(assetPrefixes) || assetPrefixes.length === 0 ||
      assetPrefixes.some((prefix) => typeof prefix !== "string" || !prefix.startsWith("/") || !prefix.endsWith("/"))) {
    throw new Error("invalid asset prefixes");
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { errors: [{ path: "", message: "must be an object" }], manifest: null };
  }
  const errors = [];
  if (candidate.version !== 2) errors.push({ path: "/version", message: "must be 2" });
  if (candidate.kind !== "layers_v2") errors.push({ path: "/kind", message: 'must be "layers_v2"' });
  if (!uuidPattern.test(candidate.revision_id)) {
    errors.push({ path: "/revision_id", message: "must be a UUID" });
  }
  const output = candidate.output;
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    errors.push({ path: "/output", message: "must be an object" });
  } else {
    if (!integerInRange(output.width, 1, maxDimension)) {
      errors.push({ path: "/output/width", message: `must be an integer between 1 and ${maxDimension}` });
    }
    if (!integerInRange(output.height, 1, maxDimension)) {
      errors.push({ path: "/output/height", message: `must be an integer between 1 and ${maxDimension}` });
    }
    if (!colorPattern.test(output.background)) {
      errors.push({ path: "/output/background", message: "must be a hex color like #RRGGBB" });
    }
    if (integerInRange(output.width, 1, maxDimension) && integerInRange(output.height, 1, maxDimension) &&
        output.width * output.height > maxPixels) {
      errors.push({ path: "/output", message: `width times height must not exceed ${maxPixels} pixels` });
    }
  }
  if (!Array.isArray(candidate.layers) || candidate.layers.length < 1 ||
      candidate.layers.length > maxLayerCount) {
    errors.push({ path: "/layers", message: `must be an array with 1 to ${maxLayerCount} layers` });
    return { errors, manifest: null };
  }
  const layerErrors = candidate.layers.map((layer, index) => inspectLayer(layer, index, assetPrefixes));
  const seenIds = new Map();
  const seenKeys = new Map();
  candidate.layers.forEach((layer, index) => {
    if (!layer || typeof layer !== "object" || Array.isArray(layer)) return;
    if (typeof layer.id === "string") {
      if (seenIds.has(layer.id)) {
        layerErrors[index].push({ path: `/layers/${index}/id`, message: "duplicate layer id" });
      } else {
        seenIds.set(layer.id, index);
      }
    }
    if (typeof layer.layer_key === "string") {
      if (seenKeys.has(layer.layer_key)) {
        layerErrors[index].push({ path: `/layers/${index}/layer_key`, message: "duplicate layer key" });
      } else {
        seenKeys.set(layer.layer_key, index);
      }
    }
  });
  for (const layerError of layerErrors) errors.push(...layerError);
  if (errors.length > 0) return { errors, manifest: null };
  const layers = candidate.layers.map((layer) => ({
    ...layer,
    material_texture_scale_millionths: layer.material_texture_path === null
      ? 1_000_000
      : layer.material_texture_scale_millionths ?? 1_000_000,
  }));
  layers.sort((left, right) =>
    left.z_order - right.z_order ||
    left.layer_key.localeCompare(right.layer_key) ||
    left.id.localeCompare(right.id));
  return {
    errors,
    manifest: {
      version: 2,
      kind: "layers_v2",
      revision_id: candidate.revision_id,
      output: {
        width: output.width,
        height: output.height,
        background: output.background.toUpperCase(),
      },
      layers,
    },
  };
}

/**
 * formatLayerManifestErrors renders validation errors as one `path: message`
 * line each.
 */
export function formatLayerManifestErrors(errors) {
  return errors.map(({ path, message }) => `${path === "" ? "/" : path}: ${message}`).join("\n");
}

/**
 * validateLayerManifest checks a layers_v2 manifest without rendering and
 * returns { valid, errors }. Each error carries a JSON-pointer path and a
 * message. options.assetPrefixes overrides the allowed asset prefixes.
 */
export function validateLayerManifest(candidate, options = {}) {
  const { errors } = inspectLayerManifest(candidate, options);
  return { valid: errors.length === 0, errors };
}

/**
 * normalizeLayerManifest validates a layers_v2 manifest, throws the precise
 * validation errors when it is invalid, and returns the normalized copy with
 * layers sorted by z-order.
 */
export function normalizeLayerManifest(candidate, options = {}) {
  const { errors, manifest } = inspectLayerManifest(candidate, options);
  if (errors.length > 0) throw new Error(formatLayerManifestErrors(errors));
  return manifest;
}
