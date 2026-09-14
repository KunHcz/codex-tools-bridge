import { afterEach, expect, test } from "bun:test";
import { AppServerRpcError, CodexAppServer, type AppServerNotification } from "../src/web-session/app-server";

const clients: CodexAppServer[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map((client) => client.close())); });

const fixture = `
const readline = require('node:readline');
let initialized = false;
let handshake = false;
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    handshake = true;
    send({id:message.id,result:{userAgent:'fixture'}});
    return;
  }
  if (message.method === 'initialized') { initialized = handshake; return; }
  if (!initialized) { send({id:message.id,error:{code:-1,message:'missing handshake'}}); return; }
  if (message.method === 'wait') return;
  if (message.method === 'late') { setTimeout(() => send({id:message.id,result:'late'}), 40); return; }
  if (message.method === 'exit') {
    process.stderr.write('SECRET_FIXTURE_TOKEN=' + 'sensitive'.repeat(10000));
    setTimeout(() => process.exit(7), 10);
    return;
  }
  if (message.method === 'invalid') { process.stdout.write('not-json\\n'); return; }
  if (message.method === 'oversize') { process.stdout.write('x'.repeat(2000)); return; }
  if (message.method === 'error') { send({id:message.id,error:{code:-32602,message:'Invalid argument'}}); return; }
  if (message.method === 'stream') {
    send({method:'command/exec/outputDelta',params:{processId:'p1',stream:'stdout',deltaBase64:Buffer.from('hello').toString('base64'),capReached:false}});
    const line = JSON.stringify({id:message.id,result:{exitCode:0,stdout:'',stderr:''}}) + '\\n';
    process.stdout.write(line.slice(0,5));
    setTimeout(() => process.stdout.write(line.slice(5)), 5);
    return;
  }
  send({id:message.id,result:{params:message.params,env:process.env.APP_SERVER_FIXTURE}});
});
`;

function client(options: { requestTimeoutMs?: number; maxMessageBytes?: number } = {}) {
  const instance = new CodexAppServer({
    binary: process.execPath,
    args: ["-e", fixture],
    env: { APP_SERVER_FIXTURE: "configured" },
    requestTimeoutMs: 2_000,
    ...options,
  });
  clients.push(instance);
  return instance;
}

test("handshakes once before concurrent requests and forwards configured environment", async () => {
  const server = client();
  const [a, b] = await Promise.all([
    server.request<{ params: unknown; env: string }>("echo", { value: "a" }),
    server.request<{ params: unknown; env: string }>("echo", { value: "b" }),
  ]);
  expect(a).toEqual({ params: { value: "a" }, env: "configured" });
  expect(b.params).toEqual({ value: "b" });
  await expect(server.request("initialize")).rejects.toThrow("Handshake is managed");
});

test("delivers streaming output before final response and handles split JSONL", async () => {
  const server = client();
  const notifications: AppServerNotification[] = [];
  server.onNotification(() => { throw new Error("subscriber failure"); });
  const unsubscribe = server.onNotification((event) => notifications.push(event));
  const result = await server.request("stream");
  expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  expect(notifications).toEqual([{
    method: "command/exec/outputDelta",
    params: { processId: "p1", stream: "stdout", deltaBase64: "aGVsbG8=", capReached: false },
  }]);
  unsubscribe();
  await server.request("stream");
  expect(notifications).toHaveLength(1);
});

test("times out one request without poisoning subsequent or late responses", async () => {
  const server = client();
  await expect(server.request("late", {}, { timeoutMs: 10 })).rejects.toThrow("timed out: late");
  await Bun.sleep(60);
  expect(await server.request<{ params: { ok: boolean }; env: string }>("echo", { ok: true })).toEqual({ params: { ok: true }, env: "configured" });
});

test("preserves structured RPC error codes", async () => {
  const server = client();
  try { await server.request("error"); throw new Error("expected RPC error"); }
  catch (error) {
    expect(error).toBeInstanceOf(AppServerRpcError);
    expect((error as AppServerRpcError).code).toBe(-32602);
  }
});

test("process exit rejects all pending requests without exposing stderr", async () => {
  const server = client();
  await server.start();
  const pending = Promise.allSettled([server.request("wait"), server.request("exit")]);
  const results = await pending;
  for (const result of results) {
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.reason.message).toContain("exited (code 7");
      expect(result.reason.message).not.toContain("sensitive");
      expect(result.reason.message).not.toContain("SECRET_FIXTURE_TOKEN");
    }
  }
});

test("close rejects pending work, is idempotent, and prevents restart", async () => {
  const server = client();
  await server.start();
  const result = server.request("wait").catch((error: Error) => error);
  await Bun.sleep(5);
  await Promise.all([server.close(), server.close()]);
  expect(await result).toBeInstanceOf(Error);
  await expect(server.start()).rejects.toThrow("closed");
});

test("rejects malformed or oversized protocol messages", async () => {
  await expect(client().request("invalid")).rejects.toThrow("invalid JSONL");
  await expect(client({ maxMessageBytes: 1000 }).request("oversize")).rejects.toThrow("exceeded limit");
});

test("spawn failure is bounded and excludes process diagnostics", async () => {
  const server = new CodexAppServer({ binary: "/nonexistent/codex-fixture", requestTimeoutMs: 1000 });
  clients.push(server);
  await expect(server.start()).rejects.toThrow("Could not start Codex app-server");
});
