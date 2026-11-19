import { entityDefinitions } from "../shared/product-contract";
import { inputSchemas } from "./product-schema";
import { z } from "zod";
export function openapiDocument() {
  const response = {
      description:
        "Authorized operation result; errors use code, message, fieldErrors and correlationId.",
    },
    auth = { security: [{ session: [] }] };
  const paths: Record<string, any> = {
    "/config": {
      get: {
        summary: "Read configured access modes",
        responses: { 200: response },
      },
    },
    "/me": {
      get: {
        ...auth,
        summary: "Read current roles, capabilities and CSRF token",
        responses: { 200: response },
      },
    },
    "/catalog": {
      get: {
        ...auth,
        summary: "Read typed form definitions",
        responses: { 200: response },
      },
    },
    "/records": {
      get: {
        ...auth,
        summary:
          "List authorized public or private records with cursor, type, state and search",
        responses: { 200: response },
      },
      post: {
        ...auth,
        summary: "Create a strictly typed record; Idempotency-Key required",
        responses: { 201: response },
      },
    },
    "/records/{id}": {
      get: {
        ...auth,
        summary: "Read an authorized record",
        responses: { 200: response },
      },
      patch: {
        ...auth,
        summary: "Save a full private revision with mandatory If-Match",
        responses: {
          200: response,
          409: {
            description: "Revision conflict; local text must be preserved",
          },
        },
      },
    },
    "/media/uploads": {
      post: {
        ...auth,
        summary:
          "Decode/reencode an image multipart upload with source and permissionBasis; maximum 20 MiB/40 megapixels",
        responses: { 201: response },
      },
    },
    "/media/{id}": {
      get: {
        ...auth,
        summary: "Read verified authenticated media bytes",
        responses: { 200: response },
      },
    },
    "/people/import": {
      post: {
        ...auth,
        summary:
          "CSV dry-run/dedup or confirmed import with provenance/permission fields",
        responses: { 200: response },
      },
    },
    "/people/exports": {
      post: {
        ...auth,
        summary:
          "Recent-auth, contacts:export, CSRF-protected formula-safe audited CSV export with reason",
        responses: { 200: response },
      },
    },
    "/import/site": {
      post: {
        ...auth,
        summary:
          "Repeatable trusted checkout import/dry-run with stable IDs; never overwrites drafts",
        responses: { 200: response },
      },
    },
    "/auth/github/start": {
      get: {
        summary: "Start configured GitHub OAuth state/PKCE flow",
        responses: {
          302: { description: "GitHub authorization redirect" },
          503: { description: "Unconfigured OAuth" },
        },
      },
    },
    "/auth/github/callback": {
      get: {
        summary: "Consume one-time state; admit invited provider subjects only",
        responses: {
          302: response,
          403: { description: "Uninvited or invalid state" },
        },
      },
    },
  };
  for (const action of [
    "validate",
    "submit",
    "review",
    "archive",
    "preview",
    "delete",
  ])
    paths[`/records/{id}/${action}`] = {
      post: {
        ...auth,
        summary: `${action} with server-side capabilities and revision-bound state checks`,
        responses: { 200: response },
      },
    };
  for (const route of [
    "members",
    "invitations",
    "overview",
    "audit",
    "integrations",
    "job-sources",
    "jobs",
    "job-runs",
    "publications",
    "changesets",
    "operations",
  ])
    paths["/" + route] = {
      get: {
        ...auth,
        summary: `Authorized ${route} collection`,
        responses: { 200: response },
      },
    };
  return {
    openapi: "3.1.0",
    info: {
      title: "Community Administration API",
      version: "1.0.0",
      description:
        "Server-side authorization, private PostgreSQL drafts and explicit public DTOs. Provider configuration never implies publication.",
    },
    servers: [{ url: "/api/v1" }, { url: "/api" }],
    components: {
      securitySchemes: {
        session: { type: "apiKey", in: "cookie", name: "ca_session" },
      },
      schemas: Object.fromEntries(
        entityDefinitions.map((d) => [
          d.type,
          z.toJSONSchema(inputSchemas[d.type]),
        ]),
      ),
    },
    paths,
  };
}
