import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
export async function acquireRunLock(directory: string, runId: string) {
  await mkdir(directory, { recursive: true });
  const path = join(directory, ".runner-lock.json"),
    token = randomUUID();
  let file;
  try {
    file = await open(path, "wx", 0o600);
  } catch (error: any) {
    if (error.code === "EEXIST")
      throw Error(
        "E2E_RUN_IN_PROGRESS: another run owns the serial runner lock; inspect the saved pid before removing a stale lock",
      );
    throw error;
  }
  try {
    await file.writeFile(JSON.stringify({ pid: process.pid, runId, token }));
    await file.sync();
  } finally {
    await file.close();
  }
  return async () => {
    const entry = JSON.parse(await readFile(path, "utf8"));
    if (entry.token !== token) throw Error("E2E_RUN_LOCK_OWNERSHIP_CHANGED");
    await unlink(path);
  };
}
