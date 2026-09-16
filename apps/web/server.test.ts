import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWebServer } from "./server.js";
import type { WebServer } from "./server.js";

let baseUrl = "";
let web: WebServer;

beforeAll(async () => {
  web = createWebServer();
  const port = await web.listen(0, "127.0.0.1");
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await web.close();
});

describe("web static server", () => {
  it("serves the app shell", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const text = await res.text();
    expect(text).toContain("OpenStore Dashboard");
    expect(text).toContain('<script type="module" src="/src/app.js">');
  });

  it("serves the stylesheet", async () => {
    const res = await fetch(`${baseUrl}/styles.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
    expect(await res.text()).toContain(".topbar");
  });

  it("reports health", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { status: string; app: string };
    expect(json.status).toBe("ok");
    expect(json.app).toBe("openstore-web");
  });

  it("falls back to the shell for SPA routes and 404s unknown assets", async () => {
    const fallback = await fetch(`${baseUrl}/nodes`);
    expect(fallback.status).toBe(200);
    expect(await fallback.text()).toContain("OpenStore Dashboard");

    const missing = await fetch(`${baseUrl}/src/does-not-exist.js`);
    expect(missing.status).toBe(404);

    const badName = await fetch(`${baseUrl}/src/..%2Fsecret.js`);
    expect([400, 404]).toContain(badName.status);

    const wrongMethod = await fetch(`${baseUrl}/`, { method: "POST" });
    expect(wrongMethod.status).toBe(405);
  });

  it("refuses non-loopback bindings", async () => {
    const isolated = createWebServer();
    await expect(isolated.listen(0, "0.0.0.0")).rejects.toThrow(/loopback/i);
  });
});
