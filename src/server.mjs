import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const maxManifestBytes = 1024 * 1024;
const maxWorkerErrorBytes = 8192;
const workerTimeoutMs = 65_000;
const artifactBoundary = "layerforge-preview-artifacts-v1-7d61b6f4c6e84932";

function renderKey(manifest) {
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

function log(event, details) {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...details }));
}

/**
 * loadShapes imports a shape module. The module must export an object named
 * shapes that maps a profile name to an async handler.
 */
export async function loadShapes(modulePath) {
  if (!modulePath) return {};
  const loaded = await import(pathToFileURL(modulePath).href);
  if (!loaded.shapes || typeof loaded.shapes !== "object") {
    throw new Error("the shape module must export a shapes object");
  }
  return loaded.shapes;
}

function readManifest(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    request.on("data", (chunk) => {
      length += chunk.length;
      if (length > maxManifestBytes) {
        reject(new Error("manifest too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (parsed?.version !== 2 || parsed?.kind !== "layers_v2") {
          throw new Error("invalid manifest");
        }
        resolve(parsed);
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function encodeArtifactSet(artifacts) {
  const chunks = [];
  for (const artifact of artifacts) {
    chunks.push(Buffer.from(
      `--${artifactBoundary}\r\n` +
      `Content-Type: ${artifact.mimeType}\r\n` +
      `Content-Disposition: attachment; name="${artifact.role}-${artifact.mimeType.slice(6)}"\r\n` +
      `X-Preview-Role: ${artifact.role}\r\n` +
      `X-Preview-Width: ${artifact.width}\r\n` +
      `X-Preview-Height: ${artifact.height}\r\n` +
      `Content-Length: ${artifact.contents.length}\r\n\r\n`,
      "ascii",
    ));
    chunks.push(artifact.contents, Buffer.from("\r\n", "ascii"));
  }
  chunks.push(Buffer.from(`--${artifactBoundary}--\r\n`, "ascii"));
  return {
    contentType: `multipart/mixed; boundary=${artifactBoundary}`,
    body: Buffer.concat(chunks),
  };
}

async function renderJob(jobDirectory, options) {
  const manifest = JSON.parse(await fs.readFile(path.join(jobDirectory, "manifest.json"), "utf8"));
  if (manifest?.version !== 2 || manifest?.kind !== "layers_v2") {
    throw new Error("unsupported manifest");
  }
  const { renderLayerArtifactSet } = await import("./index.mjs");
  const shapes = await loadShapes(options.shapesModule);
  const artifacts = await renderLayerArtifactSet(manifest, {
    assetOrigin: options.assetOrigin,
    shapes,
    onTiming: (timing) => log("render_stage", { render_key: renderKey(manifest), ...timing }),
  });
  const output = encodeArtifactSet(artifacts);
  await fs.writeFile(path.join(jobDirectory, "response.bin"), output.body);
  await fs.writeFile(path.join(jobDirectory, "response.json"), JSON.stringify({
    contentType: output.contentType,
    contentLength: output.body.length,
  }));
}

async function runRenderJob(manifest, options) {
  const jobDirectory = await fs.mkdtemp(path.join(tmpdir(), "layerforge-"));
  try {
    await fs.writeFile(path.join(jobDirectory, "manifest.json"), JSON.stringify(manifest), {
      mode: 0o600,
    });
    const workerArguments = [fileURLToPath(import.meta.url), "--render-job", jobDirectory];
    if (options.assetOrigin) workerArguments.push("--asset-origin", options.assetOrigin);
    if (options.shapesModule) workerArguments.push("--shapes", options.shapesModule);
    const worker = spawn(process.execPath, workerArguments, {
      env: process.env,
      stdio: ["ignore", "inherit", "pipe"],
    });
    let workerError = "";
    worker.stderr.setEncoding("utf8");
    worker.stderr.on("data", (chunk) => {
      if (workerError.length < maxWorkerErrorBytes) workerError += chunk;
    });
    const timeout = setTimeout(() => worker.kill("SIGKILL"), workerTimeoutMs);
    timeout.unref();
    const [exitCode, signal] = await new Promise((resolve, reject) => {
      worker.once("error", reject);
      worker.once("exit", (code, exitSignal) => resolve([code, exitSignal]));
    });
    clearTimeout(timeout);
    if (exitCode !== 0 || signal !== null) {
      throw new Error(workerError.trim() || "render worker failed");
    }
    const metadata = JSON.parse(
      await fs.readFile(path.join(jobDirectory, "response.json"), "utf8"),
    );
    const bodyPath = path.join(jobDirectory, "response.bin");
    const body = await fs.stat(bodyPath);
    if (metadata.contentLength !== body.size || body.size < 1 ||
        !metadata.contentType.startsWith("multipart/mixed; boundary=")) {
      throw new Error("render worker output is invalid");
    }
    return { jobDirectory, bodyPath, ...metadata };
  } catch (error) {
    await fs.rm(jobDirectory, { recursive: true, force: true });
    throw error;
  }
}

/**
 * createServer returns an HTTP server with one serialized render queue. The
 * manifest arrives as JSON on POST /render; GET /health reports readiness.
 */
export function createServer({ assetOrigin, shapesModule = null } = {}) {
  if (!assetOrigin) throw new Error("asset origin is required");
  let queue = Promise.resolve();
  let queued = 0;
  return http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"status":"ok"}');
      return;
    }
    const contentType = (request.headers["content-type"] ?? "").split(";")[0].trim();
    if (request.method !== "POST" || request.url !== "/render" || contentType !== "application/json") {
      response.writeHead(404);
      response.end();
      return;
    }
    let output;
    let key;
    const received = performance.now();
    try {
      const manifest = await readManifest(request);
      key = renderKey(manifest);
      queued++;
      log("render_queued", { render_key: key, queue_depth: queued });
      output = await new Promise((resolve, reject) => {
        queue = queue.then(async () => {
          queued--;
          const started = performance.now();
          log("render_started", {
            render_key: key,
            queue_ms: Math.round(started - received),
            queue_depth: queued,
          });
          const result = await runRenderJob(manifest, { assetOrigin, shapesModule });
          log("render_completed", {
            render_key: key,
            duration_ms: Math.round(performance.now() - started),
            bytes: result.contentLength,
          });
          return result;
        });
        queue.then(resolve, reject);
        queue = queue.catch(() => undefined);
      });
      response.writeHead(200, {
        "Content-Type": output.contentType,
        "Content-Length": output.contentLength,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      await pipeline(createReadStream(output.bodyPath), response);
    } catch (error) {
      log("render_failed", {
        render_key: key,
        duration_ms: Math.round(performance.now() - received),
        error: error instanceof Error ? error.message.slice(0, maxWorkerErrorBytes) : "render failed",
      });
      if (!response.headersSent) {
        response.writeHead(502, { "Cache-Control": "no-store" });
        response.end();
      } else {
        response.destroy();
      }
    } finally {
      if (output) await fs.rm(output.jobDirectory, { recursive: true, force: true });
    }
  });
}

/**
 * startServer listens until SIGTERM or SIGINT. It reads PORT, ASSET_ORIGIN,
 * and SHAPES_MODULE when the arguments are absent.
 */
export function startServer({
  port = Number.parseInt(process.env.PORT ?? "3100", 10),
  host = "0.0.0.0",
  assetOrigin = process.env.ASSET_ORIGIN,
  shapesModule = process.env.SHAPES_MODULE ?? null,
} = {}) {
  const server = createServer({ assetOrigin, shapesModule });
  server.listen(port, host, () => log("renderer_ready", { port, concurrency: 1 }));
  const shutdown = () => server.close();
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  return server;
}

function parseWorkerOptions(arguments_) {
  const options = { assetOrigin: null, shapesModule: null };
  for (let index = 0; index < arguments_.length; index += 1) {
    if (arguments_[index] === "--asset-origin") options.assetOrigin = arguments_[index + 1];
    if (arguments_[index] === "--shapes") options.shapesModule = arguments_[index + 1];
  }
  return options;
}

if (process.argv[2] === "--render-job") {
  await renderJob(process.argv[3], parseWorkerOptions(process.argv.slice(4)));
}
