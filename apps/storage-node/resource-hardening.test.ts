import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { request } from "http";
import { createStorageNode } from "./index.js";

const nodes: Array<{ close(): Promise<void> }> = [];
const dirs: string[] = [];

afterEach(async () => {
  while (nodes.length > 0) await nodes.pop()!.close();
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function start(maxHttpRequestBodyBytes: number) {
  const dir = await mkdtemp(join(tmpdir(), "openstore-body-limit-"));
  dirs.push(dir);
  const node = createStorageNode({ storageDir: dir, maxHttpRequestBodyBytes });
  nodes.push(node);
  const port = await node.listen(0, "127.0.0.1");
  return port;
}

function postChunked(port: number, path: string, body: Buffer): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "POST", headers: { "transfer-encoding": "chunked", "content-type": "application/json" } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

describe("storage-node HTTP resource limits (051B-1)", () => {
  it("accepts a body exactly at the configured limit", async () => {
    const body = Buffer.from(JSON.stringify({ id: "exact-limit", data: Buffer.from("ok").toString("base64") }));
    const port = await start(body.length);
    const response = await fetch(`http://127.0.0.1:${port}/pieces`, { method: "POST", headers: { "content-type": "application/json" }, body });
    expect([200, 201]).toContain(response.status);
  });

  it("rejects a declared body one byte over the limit before buffering", async () => {
    const body = Buffer.from(JSON.stringify({ id: "over-limit", data: Buffer.from("ok").toString("base64") }));
    const port = await start(body.length - 1);
    const response = await fetch(`http://127.0.0.1:${port}/pieces`, { method: "POST", headers: { "content-type": "application/json" }, body });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "request body too large" });
  });

  it("rejects oversized chunked bodies on both piece APIs", async () => {
    const body = Buffer.from(JSON.stringify({ id: "chunked-over", data: Buffer.from("x").toString("base64") }));
    const port = await start(body.length - 1);
    await expect(postChunked(port, "/pieces", body)).resolves.toMatchObject({ status: 413, body: JSON.stringify({ error: "request body too large" }) });
    await expect(postChunked(port, "/v2/pieces/claims", body)).resolves.toMatchObject({ status: 413, body: JSON.stringify({ error: "request body too large" }) });
  });

  it("rejects invalid body-limit configuration", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openstore-body-limit-invalid-"));
    dirs.push(dir);
    expect(() => createStorageNode({ storageDir: dir, maxHttpRequestBodyBytes: 0 })).toThrow(/positive safe integer/);
    expect(() => createStorageNode({ storageDir: dir, maxReplayCacheEntries: 0 })).toThrow(/positive safe integer/);
  });
});
