import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { writeDesktopProviderConfig, writeDesktopProviderRegistry } from "../src/web-session/desktop-provider";

const roots: string[] = [];
const url = `http://127.0.0.1:43123/${"a".repeat(48)}/v1`;
async function workspace() { const root = await mkdtemp(join(tmpdir(), "web-desktop-provider-")); roots.push(root); return root; }
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("desktop provider project config", () => {
  test("creates private loopback config and atomically replaces its owned config", async () => {
    const root = await workspace();
    const config = join(root, ".codex", "config.toml");
    await writeDesktopProviderConfig(root, url);
    const first = await lstat(config);
    expect(first.mode & 0o777).toBe(0o600);
    const parsed = Bun.TOML.parse(await readFile(config, "utf8")) as any;
    expect(parsed.model_provider).toBe("codex_web_sessions");
    expect(parsed.approvals_reviewer).toBe("user");
    expect(parsed.model_providers.codex_web_sessions).toEqual({ name: "ChatGPT Web local tool relay", base_url: url, wire_api: "responses", requires_openai_auth: false, supports_websockets: false, request_max_retries: 0, stream_max_retries: 0 });
    const changed = url.replace("43123", "43124");
    await writeDesktopProviderConfig(root, changed);
    expect((await lstat(config)).ino).not.toBe(first.ino);
    expect(await readFile(config, "utf8")).toContain(changed);
    expect(await readdir(join(root, ".codex"))).toEqual(["config.toml"]);
  });

  test("rejects non-loopback, ambiguous and malformed provider URLs before creating config", async () => {
    const root = await workspace();
    for (const invalid of [url.replace("127.0.0.1", "localhost"), url.replace("http:", "https:"), url.replace("127.0.0.1", "127.0.0.2"), url.replace(":43123", ":0"), url.replace(":43123", ":65536"), url.replace(":43123", ":043123"), url.replace("a".repeat(48), "a".repeat(47)), `${url}/`, `${url}?x=1`, `${url}#fragment`, url.replace("127.0.0.1", "user@127.0.0.1"), `${url}\n`]) {
      await expect(writeDesktopProviderConfig(root, invalid)).rejects.toThrow("loopback");
    }
    expect(await readdir(root)).toEqual([]);
    await expect(writeDesktopProviderConfig("relative-path", url)).rejects.toThrow("absolute");
    await expect(writeDesktopProviderConfig(homedir(), url)).rejects.toThrow("global");
  });

  test("refuses existing unowned config, including a marker after another first line", async () => {
    const root = await workspace();
    await mkdir(join(root, ".codex"));
    const config = join(root, ".codex", "config.toml");
    for (const content of ['model_provider = "user-provider"\n', '\n# Managed by Codex Web Sessions desktop provider v1\n']) {
      await writeFile(config, content);
      await expect(writeDesktopProviderConfig(root, url)).rejects.toThrow("not owned");
      expect(await readFile(config, "utf8")).toBe(content);
    }
  });

  test("refuses workspace, config-directory and config-file symlinks, including dangling files", async () => {
    const root = await workspace(), outside = await workspace();
    const alias = join(root, "workspace-link");
    await symlink(outside, alias);
    await expect(writeDesktopProviderConfig(alias, url)).rejects.toThrow("real directory");
    await symlink(outside, join(root, ".codex"));
    await expect(writeDesktopProviderConfig(root, url)).rejects.toThrow("symlink");
    await rm(join(root, ".codex"));
    await mkdir(join(root, ".codex"));
    const target = join(outside, "config.toml"), config = join(root, ".codex", "config.toml");
    await symlink(target, config);
    await expect(writeDesktopProviderConfig(root, url)).rejects.toThrow("symlink");
    await writeFile(target, "unchanged\n");
    await expect(writeDesktopProviderConfig(root, url)).rejects.toThrow("symlink");
    expect(await readFile(target, "utf8")).toBe("unchanged\n");
  });
});

describe("explicit desktop provider registry", () => {
  test("preserves existing settings and comments byte-for-byte and updates only its block", async () => {
    const root = await workspace(), registry = join(root, "config.toml");
    const before = '# User comment\r\nmodel_provider = "openai"\r\nmodel = "existing"\r\n\r\n[other]\r\nvalue = "keep"\r\n';
    await writeFile(registry, before);
    await writeDesktopProviderRegistry(registry, url);
    const appended = await readFile(registry, "utf8");
    expect(appended.startsWith(before)).toBe(true);
    const after = '\n# User tail\n[profiles.personal]\nmodel = "unchanged"\n';
    await writeFile(registry, appended + after);
    await writeDesktopProviderRegistry(registry, url.replace("43123", "43124"));
    const updated = await readFile(registry, "utf8");
    expect(updated).toBe((appended + after).replace(url, url.replace("43123", "43124")));
    const parsed = Bun.TOML.parse(updated) as any;
    expect(parsed.model_provider).toBe("openai");
    expect(parsed.model).toBe("existing");
    expect(parsed.approvals_reviewer).toBeUndefined();
    expect(parsed.profiles.personal.model).toBe("unchanged");
    expect((await lstat(registry)).mode & 0o777).toBe(0o600);
    expect(await readdir(root)).toEqual(["config.toml"]);
  });

  test("creates only a named definition when the registry is absent", async () => {
    const registry = join(await workspace(), "config.toml");
    await writeDesktopProviderRegistry(registry, url);
    const parsed = Bun.TOML.parse(await readFile(registry, "utf8")) as any;
    expect(Object.keys(parsed)).toEqual(["model_providers"]);
    expect(parsed.model_providers.codex_web_sessions.base_url).toBe(url);
  });

  test("rejects user-owned provider definitions in table, quoted and inline forms", async () => {
    const registry = join(await workspace(), "config.toml");
    for (const contents of ['[model_providers.codex_web_sessions]\nname="user"\n', '[model_providers."codex_web_sessions"]\nname="user"\n', 'model_providers = { codex_web_sessions = { name = "user" } }\n']) {
      await writeFile(registry, contents);
      await expect(writeDesktopProviderRegistry(registry, url)).rejects.toThrow("user-owned");
      expect(await readFile(registry, "utf8")).toBe(contents);
    }
  });

  test("rejects unrelated settings inside an owned block and malformed markers", async () => {
    const registry = join(await workspace(), "config.toml");
    await writeDesktopProviderRegistry(registry, url);
    const original = await readFile(registry, "utf8");
    for (const changed of [original.replace('[model_providers.codex_web_sessions]', 'model = "user-change"\n[model_providers.codex_web_sessions]'), original.replace('# END Codex Web Sessions provider definition v1', '# missing end'), original + 'user_key = "unowned"\n']) {
      await writeFile(registry, changed);
      await expect(writeDesktopProviderRegistry(registry, url)).rejects.toThrow();
      expect(await readFile(registry, "utf8")).toBe(changed);
    }
    const quoted = `notes = '''\n${original}'''\n`;
    await writeFile(registry, quoted);
    await expect(writeDesktopProviderRegistry(registry, url)).rejects.toThrow("not a provider definition");
    expect(await readFile(registry, "utf8")).toBe(quoted);
  });

  test("rejects symlinks, concurrent writers and invalid routes without changing the registry", async () => {
    const root = await workspace(), registry = join(root, "config.toml"), outside = await workspace();
    await symlink(join(outside, "missing"), registry);
    await expect(writeDesktopProviderRegistry(registry, url)).rejects.toThrow("symlink");
    await rm(registry);
    await writeFile(registry, '# keep\n');
    await writeFile(join(root, '.config.toml.web-session.lock'), 'another writer');
    await expect(writeDesktopProviderRegistry(registry, url)).rejects.toThrow("concurrently");
    await expect(writeDesktopProviderRegistry(registry, `${url}?x=1`)).rejects.toThrow("loopback");
    expect(await readFile(registry, "utf8")).toBe('# keep\n');
    await symlink(root, join(outside, "alias"));
    await expect(writeDesktopProviderRegistry(join(outside, "alias", "config.toml"), url)).rejects.toThrow("symlink");
  });
});
