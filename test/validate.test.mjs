import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import { normalizeLayerManifest, renderLayerManifest, validateLayerManifest } from "../src/index.mjs";
import { allowedBlends } from "../src/manifest.mjs";

const schema = JSON.parse(readFileSync(
  new URL("../schema/layer-manifest.schema.json", import.meta.url),
  "utf8",
));
const ajv = new Ajv2020({ allErrors: true });
const schemaAccepts = ajv.compile(schema);

const revisionID = "10000000-0000-4000-8000-000000000001";
const hash = "a".repeat(64);

function layer(overrides = {}) {
  return {
    id: "20000000-0000-4000-8000-000000000001",
    layer_key: "base",
    role: "base",
    path: "/media/layers/base.png",
    content_hash: hash,
    mask_path: null,
    mask_content_hash: null,
    material_texture_path: null,
    material_texture_content_hash: null,
    blend_mode: "normal",
    opacity_basis_points: 10000,
    offset_x_micropixels: 0,
    offset_y_micropixels: 0,
    scale_x_millionths: 1000000,
    scale_y_millionths: 1000000,
    rotation_millidegrees: 0,
    z_order: 10,
    ...overrides,
  };
}

function manifest(layers, output = { width: 4, height: 4, background: "#00000000" }) {
  return {
    version: 2,
    kind: "layers_v2",
    revision_id: revisionID,
    output,
    layers,
  };
}

function layerID(index) {
  return `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

const validCases = [
  ["a manifest with only the required fields", manifest([layer()])],
  ["a custom role token", manifest([layer({ role: "custom_role_2" })])],
  ["every optional layer field", manifest([layer({
    role: "texture",
    mask_path: "/media/masks/mask.png",
    mask_content_hash: "b".repeat(64),
    material_color_hex: "#F7F2E8",
    material_texture_path: "/media/textures/cotton.png",
    material_texture_content_hash: "c".repeat(64),
    material_texture_surface: true,
    material_texture_scale_millionths: 500000,
    shape_profile: "rounded",
    shape_width_mm: 25,
    blend_mode: "multiply",
    opacity_basis_points: 5000,
    offset_x_micropixels: 1000000,
    offset_y_micropixels: -1000000,
    scale_x_millionths: 2000000,
    scale_y_millionths: 500000,
    rotation_millidegrees: 45000,
    z_order: 0,
  })])],
  ["uppercase hashes, UUIDs, and colors", manifest([layer({
    id: "20000000-0000-4000-8000-00000000000A",
    content_hash: "A".repeat(64),
    material_color_hex: "#aAbBcC",
  })])],
  ["boundary values", manifest([layer({
    blend_mode: "destination_in",
    opacity_basis_points: 0,
    offset_x_micropixels: -10000000000,
    offset_y_micropixels: 10000000000,
    scale_x_millionths: 10000,
    scale_y_millionths: 100000000,
    rotation_millidegrees: -360000,
    z_order: 1000000,
    material_texture_path: "/media/textures/cotton.png",
    material_texture_content_hash: hash,
    material_texture_scale_millionths: 8000000,
  })])],
  ["a null shape_profile and shape_width_mm", manifest([layer({ shape_profile: null, shape_width_mm: null })])],
  ["layers with equal z_order", manifest([
    layer({ layer_key: "zeta", z_order: 10 }),
    layer({ id: layerID(2), layer_key: "alpha", z_order: 10 }),
  ])],
];

for (const [name, candidate] of validCases) {
  test(`validation accepts ${name}`, () => {
    assert.deepEqual(validateLayerManifest(candidate), { valid: true, errors: [] });
    assert.equal(schemaAccepts(candidate), true);
  });
}

test("a valid manifest keeps the result shape", () => {
  assert.deepEqual(validateLayerManifest(manifest([layer()])), { valid: true, errors: [] });
});

test("falsy material_color_hex values are treated as absent", () => {
  for (const value of ["", 0, false, null]) {
    assert.equal(validateLayerManifest(manifest([layer({ material_color_hex: value })])).valid, true);
  }
});

const invalidCases = [
  {
    name: "a non-object manifest",
    path: "",
    mutate: () => null,
  },
  {
    name: "a wrong version",
    path: "/version",
    mutate: () => ({ ...manifest([layer()]), version: 1 }),
  },
  {
    name: "a wrong kind",
    path: "/kind",
    mutate: () => ({ ...manifest([layer()]), kind: "three_js" }),
  },
  {
    name: "a malformed revision_id",
    path: "/revision_id",
    mutate: () => ({ ...manifest([layer()]), revision_id: "revision-1" }),
  },
  {
    name: "a missing output",
    path: "/output",
    mutate: () => ({ ...manifest([layer()]), output: null }),
  },
  {
    name: "an out-of-range output width",
    path: "/output/width",
    mutate: () => manifest([layer()], { width: 6001, height: 4, background: "#00000000" }),
  },
  {
    name: "an out-of-range output height",
    path: "/output/height",
    mutate: () => manifest([layer()], { width: 4, height: 0, background: "#00000000" }),
  },
  {
    name: "an invalid background",
    path: "/output/background",
    mutate: () => manifest([layer()], { width: 4, height: 4, background: "ivory" }),
  },
  {
    name: "an empty layer array",
    path: "/layers",
    mutate: () => manifest([]),
  },
  {
    name: "more than 128 layers",
    path: "/layers",
    mutate: () => manifest(Array.from({ length: 129 }, (_, index) => layer({
      id: layerID(index + 1),
      layer_key: `layer_${index}`,
      z_order: index,
    }))),
  },
  {
    name: "a non-object layer",
    path: "/layers/0",
    mutate: () => manifest([null]),
  },
  {
    name: "a malformed layer id",
    path: "/layers/0/id",
    mutate: () => manifest([layer({ id: "layer-1" })]),
  },
  {
    name: "a malformed layer_key",
    path: "/layers/0/layer_key",
    mutate: () => manifest([layer({ layer_key: "Base" })]),
  },
  {
    name: "a malformed role",
    path: "/layers/0/role",
    mutate: () => manifest([layer({ role: "base role" })]),
  },
  {
    name: "a path outside the asset prefixes",
    path: "/layers/0/path",
    mutate: () => manifest([layer({ path: "/private/layers/base.png" })]),
  },
  {
    name: "a traversal path",
    path: "/layers/0/path",
    mutate: () => manifest([layer({ path: "/media/../base.png" })]),
  },
  {
    name: "a path with a query string",
    path: "/layers/0/path",
    mutate: () => manifest([layer({ path: "/media/base.png?v=1" })]),
  },
  {
    name: "a percent-encoded path",
    path: "/layers/0/path",
    mutate: () => manifest([layer({ path: "/media/base%2Epng" })]),
  },
  {
    name: "a short content_hash",
    path: "/layers/0/content_hash",
    mutate: () => manifest([layer({ content_hash: "abcd" })]),
  },
  {
    name: "an unknown blend_mode",
    path: "/layers/0/blend_mode",
    mutate: () => manifest([layer({ blend_mode: "difference" })]),
  },
  {
    name: "a missing mask_path",
    path: "/layers/0/mask_path",
    mutate: () => {
      const { mask_path, ...rest } = layer();
      return manifest([rest]);
    },
  },
  {
    name: "a mask_content_hash without a mask_path",
    path: "/layers/0/mask_content_hash",
    mutate: () => manifest([layer({ mask_content_hash: hash })]),
  },
  {
    name: "a malformed mask_content_hash",
    path: "/layers/0/mask_content_hash",
    mutate: () => manifest([layer({ mask_path: "/media/masks/mask.png", mask_content_hash: "nope" })]),
  },
  {
    name: "a mask path outside the asset prefixes",
    path: "/layers/0/mask_path",
    mutate: () => manifest([layer({ mask_path: "/private/mask.png", mask_content_hash: hash })]),
  },
  {
    name: "a material texture with a malformed hash",
    path: "/layers/0/material_texture_content_hash",
    mutate: () => manifest([layer({
      material_texture_path: "/media/textures/cotton.png",
      material_texture_content_hash: "nope",
    })]),
  },
  {
    name: "an invalid material_color_hex",
    path: "/layers/0/material_color_hex",
    mutate: () => manifest([layer({ material_color_hex: "red" })]),
  },
  {
    name: "a non-boolean material_texture_surface",
    path: "/layers/0/material_texture_surface",
    mutate: () => manifest([layer({ material_texture_surface: 1 })]),
  },
  {
    name: "a material_texture_surface without a texture",
    path: "/layers/0/material_texture_surface",
    mutate: () => manifest([layer({ material_texture_surface: true })]),
  },
  {
    name: "an out-of-range material texture scale",
    path: "/layers/0/material_texture_scale_millionths",
    mutate: () => manifest([layer({
      material_texture_path: "/media/textures/cotton.png",
      material_texture_content_hash: hash,
      material_texture_scale_millionths: 8000001,
    })]),
  },
  {
    name: "a material texture scale without a texture",
    path: "/layers/0/material_texture_scale_millionths",
    mutate: () => manifest([layer({ material_texture_scale_millionths: 500000 })]),
  },
  {
    name: "an invalid shape_profile",
    path: "/layers/0/shape_profile",
    mutate: () => manifest([layer({ shape_profile: "Rounded", shape_width_mm: 25 })]),
  },
  {
    name: "a shape_profile without a shape_width_mm",
    path: "/layers/0/shape_width_mm",
    mutate: () => manifest([layer({ shape_profile: "rounded" })]),
  },
  {
    name: "a shape_width_mm without a shape_profile",
    path: "/layers/0/shape_width_mm",
    mutate: () => manifest([layer({ shape_width_mm: 25 })]),
  },
  {
    name: "an out-of-range shape_width_mm",
    path: "/layers/0/shape_width_mm",
    mutate: () => manifest([layer({ shape_profile: "rounded", shape_width_mm: 1001 })]),
  },
  {
    name: "an out-of-range opacity",
    path: "/layers/0/opacity_basis_points",
    mutate: () => manifest([layer({ opacity_basis_points: 10001 })]),
  },
  {
    name: "a fractional opacity",
    path: "/layers/0/opacity_basis_points",
    mutate: () => manifest([layer({ opacity_basis_points: 9999.5 })]),
  },
  {
    name: "an out-of-range offset_x_micropixels",
    path: "/layers/0/offset_x_micropixels",
    mutate: () => manifest([layer({ offset_x_micropixels: 10000000001 })]),
  },
  {
    name: "an out-of-range offset_y_micropixels",
    path: "/layers/0/offset_y_micropixels",
    mutate: () => manifest([layer({ offset_y_micropixels: -10000000001 })]),
  },
  {
    name: "an out-of-range scale_x_millionths",
    path: "/layers/0/scale_x_millionths",
    mutate: () => manifest([layer({ scale_x_millionths: 9999 })]),
  },
  {
    name: "an out-of-range scale_y_millionths",
    path: "/layers/0/scale_y_millionths",
    mutate: () => manifest([layer({ scale_y_millionths: 100000001 })]),
  },
  {
    name: "an out-of-range rotation_millidegrees",
    path: "/layers/0/rotation_millidegrees",
    mutate: () => manifest([layer({ rotation_millidegrees: 360001 })]),
  },
  {
    name: "a negative z_order",
    path: "/layers/0/z_order",
    mutate: () => manifest([layer({ z_order: -1 })]),
  },
];

for (const { name, path, mutate } of invalidCases) {
  test(`validation rejects ${name}`, () => {
    const candidate = mutate();
    const result = validateLayerManifest(candidate);
    assert.equal(result.valid, false, JSON.stringify(result));
    assert.equal(result.errors[0].path, path, JSON.stringify(result.errors));
    assert.equal(schemaAccepts(candidate), false, "the schema must reject the same manifest");
  });
}

test("validation rejects duplicate layer ids that the schema cannot express", () => {
  const candidate = manifest([
    layer(),
    layer({ layer_key: "other", z_order: 20 }),
  ]);
  const result = validateLayerManifest(candidate);
  assert.equal(result.valid, false);
  assert.equal(result.errors[0].path, "/layers/1/id");
  assert.equal(schemaAccepts(candidate), true);
});

test("validation rejects duplicate layer_keys that the schema cannot express", () => {
  const candidate = manifest([
    layer(),
    layer({ id: layerID(2), z_order: 20 }),
  ]);
  const result = validateLayerManifest(candidate);
  assert.equal(result.valid, false);
  assert.equal(result.errors[0].path, "/layers/1/layer_key");
  assert.equal(schemaAccepts(candidate), true);
});

test("validation enforces the output pixel budget that the schema cannot express", () => {
  const candidate = manifest([layer()], { width: 5000, height: 5000, background: "#000000" });
  const result = validateLayerManifest(candidate);
  assert.equal(result.valid, false);
  assert.equal(result.errors[0].path, "/output");
  assert.equal(schemaAccepts(candidate), true);
});

test("validation honors custom asset prefixes", () => {
  const candidate = manifest([layer({ path: "/private/layers/base.png" })]);
  assert.equal(validateLayerManifest(candidate).valid, false);
  assert.deepEqual(
    validateLayerManifest(candidate, { assetPrefixes: ["/private/"] }),
    { valid: true, errors: [] },
  );
});

test("extra properties are tolerated at every level", () => {
  const candidate = {
    $schema: "./node_modules/layerforge/schema/layer-manifest.schema.json",
    ...manifest([layer({ plugin_hint: { seed: 4 } })]),
    product_id: "10000000-0000-4000-8000-000000000099",
    fabric_collar_width_mm: 30,
  };
  assert.deepEqual(validateLayerManifest(candidate), { valid: true, errors: [] });
  assert.equal(schemaAccepts(candidate), true);
});

test("normalizeLayerManifest sorts layers and normalizes defaults", () => {
  const normalized = normalizeLayerManifest(manifest([
    layer({ layer_key: "zeta", z_order: 30 }),
    layer({ id: layerID(3), layer_key: "alpha", z_order: 10 }),
    layer({ id: layerID(2), layer_key: "beta", z_order: 10 }),
  ], { width: 4, height: 4, background: "#f7f2e8" }));
  assert.deepEqual(normalized.layers.map(({ layer_key }) => layer_key), ["alpha", "beta", "zeta"]);
  assert.equal(normalized.output.background, "#F7F2E8");
  assert.equal(normalized.layers[0].material_texture_scale_millionths, 1000000);
});

test("normalizeLayerManifest throws the precise validation errors", () => {
  assert.throws(
    () => normalizeLayerManifest(manifest([layer({ blend_mode: "difference", z_order: -1 })])),
    /\/layers\/0\/blend_mode: must be one of normal, multiply, screen, overlay, destination_in\n\/layers\/0\/z_order: must be an integer between 0 and 1000000/,
  );
});

test("a render fails with the precise errors before loading an asset", async () => {
  let loads = 0;
  await assert.rejects(renderLayerManifest(manifest([layer({ blend_mode: "difference" })]), {
    loadAsset: async () => {
      loads += 1;
      return Buffer.alloc(0);
    },
  }), /\/layers\/0\/blend_mode: must be one of/);
  assert.equal(loads, 0);
});

test("the shipped schema is draft 2020-12 and documents the blend modes", () => {
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.deepEqual(schema.$defs.layer.properties.blend_mode.enum, [...allowedBlends.keys()]);
  assert.equal(schema.$defs.layer.properties.material_texture_surface.type, "boolean");
  assert.equal(schema.properties.layers.maxItems, 128);
});
