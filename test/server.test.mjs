import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

import { createServer } from "../src/server.mjs";

const serverPath = fileURLToPath(new URL("../src/server.mjs", import.meta.url));
const shapesPath = fileURLToPath(new URL("./fixtures/shapes.mjs", import.meta.url));

function renderManifest(overrides = {}) {
  return {
    version: 2,
    kind: "layers_v2",
    revision_id: "10000000-0000-4000-8000-000000000001",
    output: { width: 4, height: 4, background: "#F7F2E8" },
    layers: [{
      id: "20000000-0000-4000-8000-000000000001",
      layer_key: "base",
      role: "base",
      path: "/media/source.png",
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
    }],
  };
}

async function assetServer(t) {
  const source = await sharp({
    create: {
      width: 4,
      height: 4,
      channels: 4,
      background: { r: 30, g: 90, b: 60, alpha: 1 },
    },
  }).png().toBuffer();
  const server = http.createServer((request, response) => {
    if (request.url !== "/media/source.png") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "Content-Type": "image/png",
      "Content-Length": source.length,
    });
    response.end(source);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

function request(port, method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const call = http.request({ host: "127.0.0.1", port, method, path: url, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    call.on("error", reject);
    if (body) call.write(body);
    call.end();
  });
}

test("a render job writes its response and exits", async (t) => {
  const assetOrigin = await assetServer(t);
  const jobDirectory = await mkdtemp(path.join(tmpdir(), "layerforge-render-test-"));
  await writeFile(path.join(jobDirectory, "manifest.json"), JSON.stringify(renderManifest()));

  let stderr = "";
  let stdout = "";
  const worker = spawn(process.execPath, [
    serverPath, "--render-job", jobDirectory, "--asset-origin", assetOrigin,
  ], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  worker.stdout.setEncoding("utf8");
  worker.stdout.on("data", (chunk) => { stdout += chunk; });
  worker.stderr.setEncoding("utf8");
  worker.stderr.on("data", (chunk) => { stderr += chunk; });

  const timeout = setTimeout(() => worker.kill("SIGKILL"), 10_000);
  const [exitCode, signal] = await once(worker, "exit");
  clearTimeout(timeout);

  try {
    assert.equal(signal, null, "render worker did not exit after completing one job");
    assert.equal(exitCode, 0, stderr);
    const metadata = JSON.parse(await readFile(path.join(jobDirectory, "response.json"), "utf8"));
    const response = await stat(path.join(jobDirectory, "response.bin"));
    assert.match(metadata.contentType, /^multipart\/mixed; boundary=/);
    assert.equal(metadata.contentLength, response.size);
    assert.ok(response.size > 0);
    const events = stdout.trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(events.some((event) => event.event === "render_stage" && event.stage === "master"));
    assert.equal(events.filter((event) => event.stage === "artifact").length, 6);
    assert.ok(events.every((event) => /^[a-f0-9]{64}$/.test(event.render_key) && event.duration_ms >= 0));
  } finally {
    await rm(jobDirectory, { recursive: true, force: true });
  }
});

test("the service renders a manifest over HTTP", async (t) => {
  const assetOrigin = await assetServer(t);
  const server = createServer({ assetOrigin, shapesModule: shapesPath });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;

  const health = await request(port, "GET", "/health");
  assert.equal(health.status, 200);
  assert.equal(health.body.toString("utf8"), '{"status":"ok"}');

  const response = await request(port, "POST", "/render", JSON.stringify(renderManifest({
    shape_profile: "stretch",
    shape_width_mm: 25,
  })), { "Content-Type": "application/json" });
  assert.equal(response.status, 200);
  assert.match(response.headers["content-type"], /^multipart\/mixed; boundary=/);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.ok(response.body.length > 0);

  const invalid = await request(port, "POST", "/render", JSON.stringify({ version: 1, kind: "legacy" }), {
    "Content-Type": "application/json",
  });
  assert.equal(invalid.status, 502);
});
