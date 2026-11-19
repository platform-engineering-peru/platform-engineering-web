/** Never load .env or import application modules in this parent launcher. */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { childEnvironment } from "../tests/e2e/safety";
if (Number(process.versions.node.split(".")[0]) !== 22)
  throw Error("E2E_NODE_22_REQUIRED");
const child = spawn(
  process.execPath,
  [
    "--import",
    "tsx",
    fileURLToPath(new URL("../tests/e2e/runner.ts", import.meta.url)),
    ...process.argv.slice(2),
  ],
  {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: childEnvironment(process.env),
    stdio: "inherit",
  },
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => child.kill(signal));
child.once("error", (error) => {
  console.error("E2E launcher failed:", error.message);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
