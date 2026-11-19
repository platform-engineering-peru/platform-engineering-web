import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
const launch = chromium.launch.bind(chromium);
chromium.launch = (options = {}) =>
  launch({
    ...options,
    channel:
      process.env.E2E_BROWSER_CHANNEL === "chrome" ? "chrome" : "chromium",
  });
const { readFileSync } = await import("node:fs");
const installed = new WeakSet<object>();
async function protect(context: any) {
  if (installed.has(context)) return;
  installed.add(context);
  await context.route("**/*", (route: any) => {
    const url = new URL(route.request().url()),
      owned = (
        process.env.E2E_OWNED_PORTS_FILE
          ? readFileSync(process.env.E2E_OWNED_PORTS_FILE, "utf8")
          : ""
      ).split("\n");
    const active = new Set<string>();
    for (const port of owned) {
      if (/^\d+$/.test(port)) active.add(port);
      else if (/^-\d+$/.test(port)) active.delete(port.slice(1));
    }
    if (
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      !active.has(url.port) ||
      url.port === "4455"
    )
      return route.abort("blockedbyclient");
    return route.continue();
  });
}
const baseLaunch = chromium.launch.bind(chromium);
chromium.launch = async (options = {}) => {
  const browser = await baseLaunch(options),
    newContext = browser.newContext.bind(browser),
    newPage = browser.newPage.bind(browser);
  browser.newContext = async (...args) => {
    const context = await newContext(...args);
    await protect(context);
    return context;
  };
  browser.newPage = async (...args) => {
    const page = await newPage(...args);
    await protect(page.context());
    return page;
  };
  return browser;
};
// Suites use only original entry points from the explicit registry, supplied by the parent.
if (
  !process.env.E2E_SUITE_FILE ||
  process.env.E2E_SUITE_FILE.endsWith("local-gh-browser.ts")
)
  throw Error("E2E_SUITE_NOT_ALLOWED");
await import(pathToFileURL(process.env.E2E_SUITE_FILE).href);
