import { jobsWorkerState } from "../jobs/service";
import { jobsPublicationEnvironment } from "../jobs/publication";
import express, { Router } from "express";
import { readFileSync } from "node:fs";
import type pg from "pg";
import { GitHub } from "./github";
import { IntegrationService, type IntegrationOptions } from "./service";
import {
  IntegrationError,
  integrationMessage,
  publicIntegrationError,
} from "./security";
export function integrationEnvironment(pool: pg.Pool): IntegrationOptions {
  const enabled = process.env.INTEGRATIONS_LIVE_ENABLED === "true";
  if (process.env.EDITORIAL_MODE === "github" && enabled)
    throw new Error(
      "GitHub editorial mode is incompatible with the legacy live integration worker. Keep INTEGRATIONS_LIVE_ENABLED=false.",
    );
  const candidateKey = process.env.CONNECTOR_ENCRYPTION_KEY
    ? Buffer.from(process.env.CONNECTOR_ENCRYPTION_KEY, "base64")
    : undefined;
  // Invalid connector configuration disables provider use; status remains readable.
  const key =
    candidateKey?.length === 32 &&
    /^[A-Za-z0-9+/]{43}=$/.test(process.env.CONNECTOR_ENCRYPTION_KEY ?? "")
      ? candidateKey
      : undefined;
  const github =
    process.env.EDITORIAL_MODE !== "github" &&
    process.env.GITHUB_APP_ID &&
    process.env.GITHUB_APP_INSTALLATION_ID &&
    process.env.GITHUB_APP_PRIVATE_KEY_FILE &&
    process.env.WEBSITE_REPO
      ? new GitHub({
          appId: process.env.GITHUB_APP_ID,
          installationId: process.env.GITHUB_APP_INSTALLATION_ID,
          privateKey: readFileSync(
            process.env.GITHUB_APP_PRIVATE_KEY_FILE,
            "utf8",
          ),
          owner: process.env.WEBSITE_REPO.split("/")[0],
          repo: process.env.WEBSITE_REPO.split("/")[1],
          apiVersion: process.env.GITHUB_API_VERSION,
          enabled,
          requiredChecks: (
            process.env.GITHUB_REQUIRED_CHECKS ?? "Validate website"
          )
            .split(",")
            .filter(Boolean),
          requiredApprovals: Number(process.env.GITHUB_REQUIRED_APPROVALS ?? 1),
        })
      : undefined;
  return {
    pool,
    liveEnabled: enabled,
    jobsPublication: jobsPublicationEnvironment(),
    websitePublication: {
      ...jobsPublicationEnvironment(),
      eventsAuthority:
        process.env.EDITORIAL_MODE === "github" ? "github" : "local",
    },
    github,
    secretKey: key,
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
  };
}
// Mount before JSON parser, browser-origin checks and session authentication.
export function createGitHubWebhookRouter(options: IntegrationOptions) {
  const router = Router(),
    service = new IntegrationService(options);
  router.post(
    "/webhooks/github",
    express.raw({ type: "application/json", limit: "1mb" }),
    async (req, res, next) => {
      try {
        if (!Buffer.isBuffer(req.body))
          throw new IntegrationError("RAW_BODY_REQUIRED", 400);
        res
          .status(202)
          .json(
            await service.webhook(
              req.get("X-GitHub-Delivery") ?? "",
              req.get("X-Hub-Signature-256") ?? "",
              req.body,
            ),
          );
      } catch (e) {
        if (e instanceof IntegrationError)
          return res.status(e.status).json(publicIntegrationError(e));
        next(e);
      }
    },
  );
  return router;
}
export function startIntegrationWorker(
  options: IntegrationOptions,
  intervalMs = 1000,
) {
  if (process.env.EDITORIAL_MODE === "github" && options.liveEnabled)
    throw new Error(
      "GitHub editorial mode is incompatible with the legacy live integration worker.",
    );
  const service = new IntegrationService(options);
  jobsWorkerState(options.pool, true);
  let stopped = false,
    running = false;
  const run = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await service.tick();
    } finally {
      running = false;
    }
  };
  const timer = setInterval(
    () => void run().catch(() => {}),
    Math.max(100, intervalMs),
  );
  timer.unref();
  return {
    service,
    stop: async () => {
      stopped = true;
      jobsWorkerState(options.pool, false);
      clearInterval(timer);
      while (running) await new Promise((resolve) => setTimeout(resolve, 25));
    },
  };
}
export const providerDocumentation = {
  githubApp:
    "https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app",
  githubTrees: "https://docs.github.com/en/rest/git/trees",
  githubWebhooks:
    "https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries",
  githubDeployments: "https://docs.github.com/en/rest/deployments/statuses",
  greenhouse: "https://docs.greenhouse.io/job-board.html",
  lever: "https://github.com/lever/postings-api",
  linkedin:
    "https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api",
  youtube:
    "https://developers.google.com/youtube/data/guides/using_resumable_upload_protocol",
  youtubeInsert:
    "https://developers.google.com/youtube/data/reference/rest/v3/videos/insert",
};
