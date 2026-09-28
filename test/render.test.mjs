import assert from "node:assert/strict";
import test from "node:test";

import sharp from "sharp";

import {
  previewArtifactSpecs,
  renderLayerArtifactSet,
  renderLayerManifest,
  validateLayerManifest,
} from "../src/index.mjs";

const revisionID = "10000000-0000-4000-8000-000000000001";
const hash = "a".repeat(64);

async function solid(width, height, rgba) {
  return sharp({
    create: { width, height, channels: 4, background: rgba },
  }).png().toBuffer();
}

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

function loader(assets) {
  return async (path) => {
    const asset = assets.get(path);
    if (!asset) throw new Error(`missing fixture: ${path}`);
    return asset;
  };
}

async function pixel(buffer, x, y) {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const index = (y * info.width + x) * 4;
  return [...data.subarray(index, index + 4)];
}

test("a material color fills only the masked area without a texture download", async () => {
  const source = await solid(4, 4, "white");
  const mask = await sharp({ create: { width: 4, height: 4, channels: 4, background: "transparent" } })
    .composite([{ input: await solid(2, 4, "white"), left: 0, top: 0 }]).png().toBuffer();
  const result = await renderLayerManifest(manifest([layer({
    material_color_hex: "#123456", mask_path: "/media/mask.png", mask_content_hash: hash,
  })]), { loadAsset: loader(new Map([["/media/layers/base.png", source], ["/media/mask.png", mask]])) });
  const pixels = await sharp(result).ensureAlpha().raw().toBuffer();
  assert.deepEqual([...pixels.subarray(0, 4)], [18, 52, 86, 255]);
  assert.equal(pixels[15], 0);
});

test("a render fetches a reused asset only once", async () => {
  let loads = 0;
  const asset = await solid(4, 4, { r: 30, g: 60, b: 90, alpha: 1 });
  await renderLayerManifest(manifest([
    layer(),
    layer({ id: "20000000-0000-4000-8000-000000000002", layer_key: "shade", z_order: 20 }),
  ]), { loadAsset: async () => { loads++; return asset; } });
  assert.equal(loads, 1);
});

test("small ordered layers are composited in one master pass", async () => {
  const asset = await solid(4, 4, { r: 30, g: 60, b: 90, alpha: 1 });
  const timings = [];
  await renderLayerManifest(manifest([
    layer(),
    layer({ id: "20000000-0000-4000-8000-000000000002", layer_key: "shade", z_order: 20 }),
    layer({ id: "20000000-0000-4000-8000-000000000003", layer_key: "hardware", z_order: 30 }),
  ]), { loadAsset: async () => asset, onTiming: (event) => timings.push(event) });
  const composites = timings.filter(({ stage }) => stage.startsWith("composite"));
  assert.equal(composites.length, 1);
  assert.equal(composites[0].layers, 3);
});

test("large overlay stacks are split at the decoded-memory budget", async () => {
  const asset = await solid(1024, 1024, { r: 30, g: 60, b: 90, alpha: 1 });
  const timings = [];
  const layers = Array.from({ length: 9 }, (_, index) => layer({
    id: `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    layer_key: `layer_${index}`, z_order: index,
  }));
  const result = await renderLayerManifest(manifest(layers,
    { width: 1024, height: 1024, background: "#00000000" }),
  { loadAsset: async () => asset, onTiming: (event) => timings.push(event) });
  assert.deepEqual(timings.filter(({ stage }) => stage.startsWith("composite")).map(({ layers: count }) => count), [8, 1]);
  assert.deepEqual(await pixel(result, 512, 512), [30, 60, 90, 255]);
});

test("normal, multiply, and screen layers composite in z-order", async () => {
  const assets = new Map([
    ["/media/layers/red.png", await solid(4, 4, { r: 255, g: 0, b: 0, alpha: 1 })],
    ["/media/layers/half.png", await solid(4, 4, { r: 128, g: 128, b: 128, alpha: 1 })],
    ["/media/layers/blue.png", await solid(4, 4, { r: 0, g: 0, b: 255, alpha: 1 })],
  ]);
  const result = await renderLayerManifest(manifest([
    layer({ id: "20000000-0000-4000-8000-000000000003", path: "/media/layers/blue.png", layer_key: "screen", blend_mode: "screen", z_order: 30 }),
    layer({ id: "20000000-0000-4000-8000-000000000001", path: "/media/layers/red.png", layer_key: "red", z_order: 10 }),
    layer({ id: "20000000-0000-4000-8000-000000000002", path: "/media/layers/half.png", layer_key: "multiply", blend_mode: "multiply", z_order: 20 }),
  ]), { loadAsset: loader(assets) });

  const [red, green, blue, alpha] = await pixel(result, 2, 2);
  assert.ok(red >= 126 && red <= 129);
  assert.equal(green, 0);
  assert.equal(blue, 255);
  assert.equal(alpha, 255);
});

test("a variable-alpha mask clips only its own layer", async () => {
  const source = await solid(4, 4, { r: 250, g: 20, b: 20, alpha: 1 });
  const maskRaw = Buffer.alloc(4 * 4 * 4, 255);
  for (let y = 0; y < 4; y += 1) {
    for (let x = 2; x < 4; x += 1) maskRaw[(y * 4 + x) * 4 + 3] = 0;
  }
  const mask = await sharp(maskRaw, { raw: { width: 4, height: 4, channels: 4 } }).png().toBuffer();
  const assets = new Map([
    ["/media/layers/source.png", source],
    ["/media/masks/half.png", mask],
  ]);
  const result = await renderLayerManifest(manifest([
    layer({
      path: "/media/layers/source.png",
      mask_path: "/media/masks/half.png",
      mask_content_hash: "b".repeat(64),
    }),
  ]), { loadAsset: loader(assets) });

  assert.deepEqual(await pixel(result, 0, 2), [250, 20, 20, 255]);
  assert.deepEqual(await pixel(result, 3, 2), [0, 0, 0, 0]);
});

test("material textures tile through the source alpha", async () => {
  const source = await solid(4, 2, { r: 255, g: 255, b: 255, alpha: 1 });
  const textureRaw = Buffer.from([
    255, 0, 0, 255,
    0, 255, 0, 255,
  ]);
  const texture = await sharp(textureRaw, { raw: { width: 2, height: 1, channels: 4 } }).png().toBuffer();
  const assets = new Map([
    ["/media/layers/source.png", source],
    ["/media/textures/check.png", texture],
  ]);
  const result = await renderLayerManifest(manifest([
    layer({
      path: "/media/layers/source.png",
      material_texture_path: "/media/textures/check.png",
      material_texture_content_hash: "c".repeat(64),
    }),
  ], { width: 4, height: 2, background: "#00000000" }), { loadAsset: loader(assets) });

  const first = (await pixel(result, 0, 0)).slice(0, 3);
  const second = (await pixel(result, 1, 0)).slice(0, 3);
  assert.notDeepEqual(first, second);
  assert.deepEqual((await pixel(result, 2, 0)).slice(0, 3), first);
  assert.deepEqual((await pixel(result, 3, 0)).slice(0, 3), second);
});

test("oversized material textures are center-cropped without shrinking the pattern", async (t) => {
  for (const [width, height] of [[8, 8], [8, 2], [2, 8]]) {
    await t.test(`${width} by ${height} texture on a 4 by 4 layer`, async () => {
      const sourceRaw = Buffer.alloc(4 * 4 * 4, 255);
      sourceRaw[(3 * 4 + 3) * 4 + 3] = 0;
      const source = await sharp(sourceRaw, { raw: { width: 4, height: 4, channels: 4 } }).png().toBuffer();
      const textureRaw = Buffer.alloc(width * height * 4);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        textureRaw.set([x * 30, y * 30, 90, 255], (y * width + x) * 4);
      }
      const texture = await sharp(textureRaw, { raw: { width, height, channels: 4 } }).png().toBuffer();
      const result = await renderLayerManifest(manifest([layer({
        material_texture_path: "/media/textures/large.png",
        material_texture_content_hash: hash,
      })]), { loadAsset: loader(new Map([
        ["/media/layers/base.png", source],
        ["/media/textures/large.png", texture],
      ])) });

      const metadata = await sharp(result).metadata();
      assert.deepEqual([metadata.width, metadata.height], [4, 4]);
      assert.deepEqual(await pixel(result, 3, 3), [0, 0, 0, 0]);
      for (let axis = 0; axis < 2; axis++) {
        const size = [width, height][axis];
        const values = await Promise.all([0, 1, 2, 3].map(async (position) =>
          (await pixel(result, axis === 0 ? position : 0, axis === 1 ? position : 0))[axis]));
        if (size > 4) assert.deepEqual(values, [60, 90, 120, 150]);
        else {
          assert.notEqual(values[0], values[1]);
          assert.deepEqual(values.slice(0, 2), values.slice(2, 4));
        }
      }
    });
  }
});

test("material texture scale changes motif size without changing layer bounds", async () => {
  const sourceRaw = Buffer.alloc(8 * 2 * 4, 255);
  for (let y = 0; y < 2; y += 1) {
    for (let x = 6; x < 8; x += 1) sourceRaw[(y * 8 + x) * 4 + 3] = 0;
  }
  const source = await sharp(sourceRaw, { raw: { width: 8, height: 2, channels: 4 } }).png().toBuffer();
  const texture = await sharp(Buffer.from([
    255, 0, 0, 255,
    0, 255, 0, 255,
  ]), { raw: { width: 2, height: 1, channels: 4 } }).png().toBuffer();
  const assets = new Map([
    ["/media/layers/source.png", source],
    ["/media/textures/check.png", texture],
  ]);
  const render = (scale) => renderLayerManifest(manifest([
    layer({
      path: "/media/layers/source.png",
      material_texture_path: "/media/textures/check.png",
      material_texture_content_hash: "c".repeat(64),
      material_texture_scale_millionths: scale,
    }),
  ], { width: 8, height: 2, background: "#00000000" }), { loadAsset: loader(assets) });

  const small = await render(700000);
  const large = await render(1500000);
  assert.notDeepEqual(small, large);
  for (let x = 0; x < 8; x += 1) {
    assert.equal((await pixel(small, x, 0))[3], (await pixel(large, x, 0))[3]);
  }
});

test("zero texture scale on an untextured layer is neutral", () => {
  const normalized = validateLayerManifest(manifest([
    layer({ material_texture_scale_millionths: 0 }),
  ]));
  assert.equal(normalized.layers[0].material_texture_scale_millionths, 1_000_000);
});

test("material texture scale accepts up to eight times", () => {
  const calibrated = (scale) => manifest([layer({
    material_texture_path: "/media/textures/cotton.png",
    material_texture_content_hash: hash,
    material_texture_scale_millionths: scale,
  })]);
  assert.equal(validateLayerManifest(calibrated(8_000_000)).layers[0].material_texture_scale_millionths, 8_000_000);
  assert.throws(() => validateLayerManifest(calibrated(8_000_001)), /material texture scale/);
});

test("a shape plugin reshapes the layer before texturing", async () => {
  const source = await solid(2, 2, { r: 200, g: 30, b: 30, alpha: 1 });
  const shapes = {
    stretch: async (bytes, { widthMm }) => {
      assert.equal(widthMm, 25);
      return sharp(bytes).resize(4, 4, { fit: "fill" }).png().toBuffer();
    },
  };
  const result = await renderLayerManifest(manifest([
    layer({ path: "/media/layers/source.png", shape_profile: "stretch", shape_width_mm: 25 }),
  ], { width: 4, height: 4, background: "#00000000" }), {
    loadAsset: loader(new Map([["/media/layers/source.png", source]])),
    shapes,
  });
  assert.deepEqual(await pixel(result, 0, 0), [200, 30, 30, 255]);
  assert.deepEqual(await pixel(result, 3, 3), [200, 30, 30, 255]);
});

test("an unknown shape profile is rejected", async () => {
  const source = await solid(2, 2, "white");
  await assert.rejects(renderLayerManifest(manifest([
    layer({ shape_profile: "missing", shape_width_mm: 10 }),
  ]), { loadAsset: async () => source }), /unknown shape profile/);
});

test("shape width is required and bounded", () => {
  assert.throws(() => validateLayerManifest(manifest([layer({ shape_profile: "stretch" })])));
  assert.throws(() => validateLayerManifest(manifest([layer({ shape_profile: "stretch", shape_width_mm: 0 })])));
  assert.throws(() => validateLayerManifest(manifest([layer({ shape_width_mm: 25 })])));
});

test("translate, scale, and rotate are deterministic", async () => {
  const source = await solid(2, 1, { r: 20, g: 80, b: 220, alpha: 1 });
  const candidate = manifest([
    layer({
      path: "/media/layers/source.png",
      offset_x_micropixels: 1000000,
      scale_x_millionths: 2000000,
      rotation_millidegrees: 90000,
    }),
  ], { width: 8, height: 8, background: "#00000000" });
  const loadAsset = loader(new Map([["/media/layers/source.png", source]]));

  const first = await renderLayerManifest(candidate, { loadAsset });
  const second = await renderLayerManifest(candidate, { loadAsset });
  assert.deepEqual(first, second);
  assert.equal((await sharp(first).metadata()).width, 8);
  assert.equal((await sharp(first).metadata()).height, 8);
});

for (const { name, width, height, rotation = 0, scale = 100_000_000 } of [
  { name: "unscaled width", width: 6001, height: 1, scale: 1_000_000 },
  { name: "scaled width", width: 61, height: 1 },
  { name: "scaled height", width: 1, height: 61 },
  { name: "scaled pixel count", width: 41, height: 41 },
  { name: "rotated pixel count", width: 30, height: 30, rotation: 45_000 },
  { name: "negative rotated pixel count", width: 30, height: 30, rotation: -45_000 },
  { name: "rotated width", width: 60, height: 1, rotation: 1_000 },
  { name: "rotated height", width: 1, height: 60, rotation: 1_000 },
]) {
  test(`oversized transform rejects ${name} before any resize allocation`, async (t) => {
    const source = await solid(width, height, { r: 20, g: 80, b: 220, alpha: 1 });
    const resize = t.mock.method(sharp.prototype, "resize", () => {
      throw new Error("unsafe resize reached before transform validation");
    });
    await assert.rejects(renderLayerManifest(manifest([layer({
      scale_x_millionths: scale,
      scale_y_millionths: scale,
      rotation_millidegrees: rotation,
      offset_x_micropixels: 10_000_000_000,
    })]), { loadAsset: async () => source }), /transformed layer is too large/);
    assert.equal(resize.mock.callCount(), 0);
  });
}

test("quarter turns preserve a layer at the dimension budget", async () => {
  const source = await solid(6000, 1, { r: 20, g: 80, b: 220, alpha: 1 });
  for (const rotation of [-360_000, -270_000, -180_000, -90_000, 0, 90_000, 180_000, 270_000, 360_000]) {
    const result = await renderLayerManifest(manifest([layer({
      rotation_millidegrees: rotation,
    })]), { loadAsset: async () => source });
    const metadata = await sharp(result).metadata();
    assert.equal(metadata.width, 4);
    assert.equal(metadata.height, 4);
  }
});

test("validation rejects unsafe paths, unsupported blends, and oversized output", () => {
  const cases = [
    manifest([layer({ path: "https://example.test/asset.png" })]),
    manifest([layer({ path: "/media/../secret.png" })]),
    manifest([layer({ path: "/private/asset.png" })]),
    manifest([layer({ blend_mode: "difference" })]),
    manifest([layer()], { width: 6001, height: 4, background: "#00000000" }),
    manifest([layer()], { width: 5000, height: 5000, background: "#00000000" }),
  ];
  for (const candidate of cases) {
    assert.throws(() => validateLayerManifest(candidate));
  }
  const custom = manifest([layer({ path: "/private/asset.png" })]);
  assert.equal(validateLayerManifest(custom, { assetPrefixes: ["/private/"] }).layers[0].path, "/private/asset.png");
});

test("responsive artifact set contains matching AVIF and WebP roles", async () => {
  const source = await solid(6, 4, { r: 52, g: 104, b: 78, alpha: 1 });
  const candidate = manifest(
    [layer({ path: "/media/layers/source.png" })],
    { width: 6, height: 4, background: "#F7F2E8" },
  );
  const first = await renderLayerArtifactSet(candidate, {
    loadAsset: loader(new Map([["/media/layers/source.png", source]])),
  });
  const second = await renderLayerArtifactSet(candidate, {
    loadAsset: loader(new Map([["/media/layers/source.png", source]])),
  });
  assert.deepEqual(
    first.map(({ role, mimeType, width, height }) => ({ role, mimeType, width, height })),
    previewArtifactSpecs,
  );
  assert.equal(first.length, 6);
  for (let index = 0; index < first.length; index += 1) {
    const metadata = await sharp(first[index].contents).metadata();
    assert.equal(metadata.width, first[index].width);
    assert.equal(metadata.height, first[index].height);
    assert.equal(
      metadata.format,
      first[index].mimeType === "image/avif" ? "heif" : "webp",
    );
    assert.deepEqual(first[index].contents, second[index].contents);
  }
});
