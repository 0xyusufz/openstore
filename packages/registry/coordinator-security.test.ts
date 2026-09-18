import { describe, expect, it } from "vitest";
import { createRegistry } from "./index.js";
import { createRegistryCoordinator } from "./coordinator.js";

/**
 * Milestone 066: coordinator authentication boundary.
 * - Bearer comparison is constant-time (wrong-length and wrong-value tokens
 *   both fail closed with 401 and identical error shape).
 * - Readiness stays public for orchestrators; everything else (metrics,
 *   nodes, status, events, recovery) requires the token when configured.
 * - Recovery endpoints never leak key material or internal paths.
 */
describe("Milestone 066: coordinator authentication boundary", () => {
  it("rejects missing, wrong-length, and wrong-value bearers identically", async () => {
    const coordinator = createRegistryCoordinator({ registry: createRegistry(), token: "secret-token" });
    const port = await coordinator.listen(0);
    try {
      const cases = [
        await fetch(`http://127.0.0.1:${port}/v1/nodes`),
        await fetch(`http://127.0.0.1:${port}/v1/nodes`, { headers: { authorization: "Bearer short" } }),
        await fetch(`http://127.0.0.1:${port}/v1/nodes`, { headers: { authorization: "Bearer secret-token-wrong" } }),
        await fetch(`http://127.0.0.1:${port}/v1/nodes`, { headers: { authorization: "Basic c2VjcmV0" } }),
      ];
      for (const response of cases) {
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: "unauthorized" });
      }
      const ok = await fetch(`http://127.0.0.1:${port}/v1/nodes`, { headers: { authorization: "Bearer secret-token" } });
      expect(ok.status).toBe(200);
    } finally {
      await coordinator.close();
    }
  });

  it("keeps readiness public but gates metrics, status, events, and recovery", async () => {
    const coordinator = createRegistryCoordinator({ registry: createRegistry(), token: "secret" });
    const port = await coordinator.listen(0);
    try {
      expect((await fetch(`http://127.0.0.1:${port}/v1/ready`)).status).toBe(200);
      for (const path of ["/v1/metrics", "/v1/status", "/v1/events", "/v1/nodes", "/v1/recovery/inspect"]) {
        expect((await fetch(`http://127.0.0.1:${port}${path}`)).status).toBe(401);
      }
      const authed = { headers: { authorization: "Bearer secret" } };
      expect((await fetch(`http://127.0.0.1:${port}/v1/metrics`, authed)).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${port}/v1/status`, authed)).status).toBe(200);
    } finally {
      await coordinator.close();
    }
  });

  it("leaves everything public when no token is configured (explicit opt-out)", async () => {
    const coordinator = createRegistryCoordinator({ registry: createRegistry() });
    const port = await coordinator.listen(0);
    try {
      expect((await fetch(`http://127.0.0.1:${port}/v1/metrics`)).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${port}/v1/nodes`)).status).toBe(200);
    } finally {
      await coordinator.close();
    }
  });

  it("sanitizes recovery error responses without key material or paths", async () => {
    const coordinator = createRegistryCoordinator({ registry: createRegistry(), token: "secret" });
    const port = await coordinator.listen(0);
    try {
      const authedJson = {
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
      };
      const response = await fetch(`http://127.0.0.1:${port}/v1/recovery/prepare`, {
        method: "POST",
        ...authedJson,
        body: JSON.stringify({ evidence: null, authorization: { privateKey: "should-never-appear" } }),
      });
      // No recovery runtime is wired here, so the endpoint fails closed.
      expect(response.status).toBe(503);
      const text = await response.text();
      expect(text).not.toMatch(/should-never-appear|privateKey|BEGIN .*PRIVATE/i);
    } finally {
      await coordinator.close();
    }
  });

  it("rejects oversized coordinator bodies without processing them", async () => {
    const coordinator = createRegistryCoordinator({ registry: createRegistry(), token: "secret", maxBodyBytes: 64 });
    const port = await coordinator.listen(0);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/register`, {
        method: "POST",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        body: JSON.stringify({ padding: "x".repeat(1024) }),
      });
      expect(response.status).toBe(400);
    } finally {
      await coordinator.close();
    }
  });
});
