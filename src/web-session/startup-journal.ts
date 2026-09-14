import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { DesktopStartupRecord } from "./desktop-session-controller";

/** Only startup state, never prompts or tool arguments. Pending is committed
 * before dispatch so a bridge restart cannot blindly submit the same startup.
 */
export function startupJournal(stateDir: string) {
  const path = join(stateDir, "desktop-startups.json");
  let queue: Promise<unknown> = Promise.resolve();
  const load = async (): Promise<Record<string, DesktopStartupRecord>> => {
    try { return JSON.parse(await readFile(path, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  };
  return {
    async read(threadId: string) { await queue; return (await load())[threadId]; },
    async write(threadId: string, record: DesktopStartupRecord) {
      const next = queue.then(async () => {
        const records = await load(); records[threadId] = record;
        const temp = `${path}.${randomUUID()}.tmp`;
        await writeFile(temp, JSON.stringify(records), { mode: 0o600 });
        await rename(temp, path);
      });
      queue = next.catch(() => {});
      return next;
    },
  };
}
