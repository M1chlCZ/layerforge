# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `validateLayerManifest(manifest)` returns `{ valid, errors }` with precise
  JSON-pointer error paths for every manifest rule, including the cross-field
  rules.
- `normalizeLayerManifest(manifest)` runs the same checks, throws the precise
  errors and returns the normalized manifest with layers sorted by `z_order`.
- `schema/layer-manifest.schema.json`, a JSON Schema draft 2020-12 for the
  `layers_v2` manifest. It ships with the package and is importable through the
  `layerforge/schema/layer-manifest.schema.json` subpath.
- The CLI flag `--validate manifest.json` prints one `path: message` line per
  error and exits 0 for a valid manifest, 1 for an invalid manifest, and 2 for
  a usage error. Usage errors now exit 2 for every command.

### Changed

- Rendering an invalid manifest fails before any asset is loaded and reports
  the precise validation errors. Error messages changed from short labels such
  as `invalid layer` to precise paths and messages such as
  `/layers/2/blend_mode: must be one of ...`.
- `validateLayerManifest` no longer throws or returns the normalized manifest;
  use `normalizeLayerManifest` for the normalized copy.
