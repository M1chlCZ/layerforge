import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

function runCLI(arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...arguments_], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function layer(overrides = {}) {
  return {
    id: "20000000-0000-4000-8000-000000000001",
    layer_key: "base",
    role: "base",
    path: "/media/layers/base.png",
    content_hash: "a".repeat(64),
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

function manifest(layers) {
  return {
    version: 2,
    kind: "layers_v2",
    revision_id: "10000000-0000-4000-8000-000000000001",
    output: { width: 4, height: 4, background: "#00000000" },
    layers,
  };
}

async function manifestFile(t, contents) {
  const directory = await mkdtemp(path.join(tmpdir(), "layerforge-cli-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "manifest.json");
  await writeFile(file, contents);
  return file;
}

test("--validate exits 0 for a valid manifest", async (t) => {
  const file = await manifestFile(t, JSON.stringify(manifest([layer()])));
  const result = await runCLI(["--validate", file]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "");
});

test("--validate prints one precise error per line and exits 1", async (t) => {
  const file = await manifestFile(t, JSON.stringify(manifest([
    layer({ blend_mode: "difference", z_order: -1 }),
  ])));
  const result = await runCLI(["--validate", file]);
  assert.equal(result.code, 1, result.stderr);
  assert.deepEqual(result.stdout.trimEnd().split("\n"), [
    "/layers/0/blend_mode: must be one of normal, multiply, screen, overlay, destination_in",
    "/layers/0/z_order: must be an integer between 0 and 1000000",
  ]);
});

test("--validate exits 2 without a manifest path", async () => {
  const result = await runCLI(["--validate"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /usage: layerforge --validate/);
});

test("--validate exits 2 for an unknown option", async () => {
  const result = await runCLI(["--nope"]);
  assert.equal(result.code, 2);
});

test("--validate exits 1 for a manifest that is not JSON", async (t) => {
  const file = await manifestFile(t, "{ not json");
  const result = await runCLI(["--validate", file]);
  assert.equal(result.code, 1);
  assert.ok(result.stderr.length > 0);
});
