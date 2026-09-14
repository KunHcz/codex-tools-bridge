import { expect, test } from "bun:test";
import { IdleAppServer } from "../src/web-session/idle-app-server";

test("Desktop auxiliary process stays absent until use and is recreated after idle release", async () => {
  let created = 0, closed = 0, calls = 0;
  const server = new IdleAppServer(() => {
    created++;
    return {
      async start() {}, onNotification() { return () => {}; },
      async request<T>() { calls++; return { ok: true } as T; },
      async close() { closed++; },
    };
  }, 10);
  try {
    await server.start();
    expect(created).toBe(0);
    await Promise.all([server.request("read", {}), server.request("read", {})]);
    expect(created).toBe(1);
    await Bun.sleep(30);
    expect(closed).toBe(1);
    expect(server.status().started).toBe(false);
    await server.request("read", {});
    expect(created).toBe(2);
    expect(calls).toBe(3);
  } finally { await server.close(); }
});

test("idle release never interrupts an active command and failures are not replayed", async () => {
  let finish!: (value: unknown) => void;
  let closed = 0, calls = 0;
  const server = new IdleAppServer(() => ({
    async start() {}, onNotification() { return () => {}; },
    async request<T>(method: string) {
      calls++;
      if (method === "command/exec") return await new Promise<unknown>(resolve => { finish = resolve; }) as T;
      throw new Error("disconnected");
    },
    async close() { closed++; },
  }), 10);
  try {
    const job = server.request("command/exec", { processId: "one" });
    await Bun.sleep(30);
    expect(closed).toBe(0);
    expect(server.status().activeCommands).toBe(1);
    finish({ exitCode: 0 }); await job;
    await Bun.sleep(30);
    expect(closed).toBe(1);
    await expect(server.request("read", {})).rejects.toThrow("disconnected");
    expect(calls).toBe(2);
  } finally { await server.close(); }
});

test("unknown command outcome prevents automatic shutdown", async () => {
  let closed = 0;
  const server = new IdleAppServer(() => ({
    async start() {}, onNotification() { return () => {}; },
    async request<T>(): Promise<T> { throw new Error("request timed out"); },
    async close() { closed++; },
  }), 10);
  try {
    await expect(server.request("command/exec", { processId: "unknown" })).rejects.toThrow("timed out");
    await Bun.sleep(30);
    expect(closed).toBe(0);
    expect(server.status().activeCommands).toBe(1);
  } finally { await server.close(); }
});
