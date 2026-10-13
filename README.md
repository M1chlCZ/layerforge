# layerforge

Deterministic preview compositor for layered product images. Give it a JSON manifest and receive AVIF and WebP files for cards, detail views, and zoom.

## Features

- Composites up to 128 layers with masks, blend modes, offsets, scale, and rotation.
- Fills a masked layer with a material color, or tiles an uploaded material texture.
- Optional texture tiling and relief displacement through [seamless-texture](https://github.com/m1chlcz/seamless-texture).
- Shape plugins reshape a layer before texturing. The package ships no product profiles.
- Resizes one lossless master into six artifacts: card (320), detail (800), and zoom (1600), each in AVIF and WebP.
- Runs as a library, a CLI, or an HTTP service with one serialized queue and a subprocess worker.

## Install

```
npm install layerforge
```

Node.js 22 or later is required.

## Library

```js
import { renderLayerArtifactSet, renderLayerManifest } from "layerforge";

const master = await renderLayerManifest(manifest, { assetOrigin: "https://shop.example" });
const artifacts = await renderLayerArtifactSet(manifest, {
  assetOrigin: "https://shop.example",
  shapes,
  onTiming: (event) => console.log(event),
});
```

`renderLayerManifest` returns a lossless WebP master. `renderLayerArtifactSet` returns the six responsive files.

## Manifest

```json
{
  "version": 2,
  "kind": "layers_v2",
  "revision_id": "10000000-0000-4000-8000-000000000001",
  "output": { "width": 1200, "height": 900, "background": "#F7F2E8" },
  "layers": [
    {
      "id": "20000000-0000-4000-8000-000000000001",
      "layer_key": "base",
      "role": "base",
      "path": "/media/base.png",
      "content_hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "mask_path": null,
      "mask_content_hash": null,
      "material_texture_path": null,
      "material_texture_content_hash": null,
      "blend_mode": "normal",
      "opacity_basis_points": 10000,
      "offset_x_micropixels": 0,
      "offset_y_micropixels": 0,
      "scale_x_millionths": 1000000,
      "scale_y_millionths": 1000000,
      "rotation_millidegrees": 0,
      "z_order": 10
    }
  ]
}
```

| Layer field | Meaning |
| --- | --- |
| `id`, `layer_key`, `role` | Identity. IDs and keys must be unique. |
| `path`, `content_hash` | Source image. The SHA-256 hash is a 64-character hex string. |
| `blend_mode` | `normal`, `multiply`, `screen`, `overlay`, or `destination_in`. |
| `mask_path`, `mask_content_hash` | Optional alpha mask, resized to the layer. Set both to `null` when absent. |
| `material_color_hex` | Optional solid fill through the source alpha. |
| `material_texture_path`, `material_texture_content_hash` | Optional tiled texture. Set both to `null` when absent. |
| `material_texture_surface` | Apply seamless tiling and relief displacement. |
| `material_texture_scale_millionths` | Texture scale, 100000 to 8000000. |
| `shape_profile`, `shape_width_mm` | Optional shape plugin and its width. |
| `opacity_basis_points` | 0 to 10000, where 10000 is opaque. |
| `offset_x_micropixels`, `offset_y_micropixels` | Center offset in millionths of a pixel. |
| `scale_x_millionths`, `scale_y_millionths` | Layer scale in millionths. |
| `rotation_millidegrees` | Rotation in thousandths of a degree. |
| `z_order` | Draw order. Ties sort by `layer_key`, then `id`. |

Asset paths must stay under the asset prefixes (`/media/` and `/cad/` by default) and must have no query, fragment, or `..` segment. Set `assetPrefixes` to change the allowed prefixes.

## Validation

`validateLayerManifest` checks a manifest without rendering and reports every problem. Each error has a JSON-pointer-style path and a message:

```js
import { validateLayerManifest } from "layerforge";

const { valid, errors } = validateLayerManifest(manifest);
for (const { path, message } of errors) {
  console.error(`${path}: ${message}`);
}
```

`normalizeLayerManifest` applies the same checks and returns the normalized manifest with the layers sorted by `z_order`. It throws an error with one line per problem when the manifest is invalid. A render validates the manifest first, so an invalid manifest fails with the same errors before any asset is loaded.

The CLI checks a file without rendering:

```
layerforge --validate manifest.json
```

It prints one `path: message` line per error. The exit code is 0 for a valid manifest, 1 for an invalid manifest, and 2 for a usage error.

`schema/layer-manifest.schema.json` is a JSON Schema draft 2020-12 for the manifest. Editors pick it up through the `$schema` property:

```json
{
  "$schema": "./node_modules/layerforge/schema/layer-manifest.schema.json",
  "version": 2,
  "kind": "layers_v2"
}
```

The published URL is `https://raw.githubusercontent.com/M1chlCZ/layerforge/main/schema/layer-manifest.schema.json`. The schema covers the default asset prefixes (`/media/` and `/cad/`). `validateLayerManifest` also checks the rules JSON Schema cannot express: unique layer `id` and `layer_key` values, the output pixel budget, and custom `assetPrefixes`. Unknown properties are accepted at every level; the renderer ignores top-level extras and passes layer extras to shape plugins.

## Shape plugins

A shape plugin reshapes or recolors one layer before texturing:

```js
export const shapes = {
  rounded: async (source, { widthMm, layer }) => sharp(source)
    .resize({ width: widthMm * 10, fit: "fill" })
    .png()
    .toBuffer(),
};
```

Pass the module to the library through `shapes`, to the CLI through `--shapes FILE`, or to the service through `SHAPES_MODULE`. A layer with an unknown profile fails the render. A layer with a shape profile skips the material color fill, because the plugin owns the look of the layer.

## CLI

```
layerforge render manifest.json --out preview --asset-origin https://shop.example --shapes shapes.mjs
layerforge --validate manifest.json
layerforge serve --port 3100 --asset-origin https://shop.example
```

The CLI reads `ASSET_ORIGIN`, `SHAPES_MODULE`, and `PORT` when the flag is absent.

## Service

- `POST /render` with the manifest as JSON returns `multipart/mixed` with the six artifacts and `X-Preview-Role`, `X-Preview-Width`, and `X-Preview-Height` headers.
- `GET /health` returns `{"status":"ok"}`.
- One render runs at a time. Each render runs in a subprocess with a 65 second limit.
- The asset origin is trusted. Content hashes are format-checked, so configure an origin that you control.

```
docker build -t layerforge .
docker run --rm -p 3100:3100 -e ASSET_ORIGIN=https://shop.example layerforge
```

## Limits

| Item | Limit |
| --- | --- |
| Output | 6000 per axis, 16 megapixels |
| Layers | 128 |
| Asset | 16 MiB |
| Manifest | 1 MiB |

## Third-party licenses

- `sharp` and its `@img/sharp-*` platform packages use Apache-2.0.
- The `@img/sharp-libvips-*` platform packages use LGPL-3.0-or-later. npm installs them for the target platform; they are not part of this package.
- Keep the license texts when you redistribute a built image or a bundled copy.

## Development

```
npm ci
npm test
npm run benchmark
```

## License

MIT. See `LICENSE`.
