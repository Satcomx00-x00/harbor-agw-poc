/**
 * The tools this server exposes.
 *
 * Read-only on purpose. The interesting question this lab asks is "whose
 * identity reached Harbor", and every write tool added here is a way to answer
 * it destructively. Deletion and push are left to the Harbor UI and the docker
 * CLI, which authenticate the same way.
 *
 * Registration takes a `HarborClient` that is already bound to one caller's
 * token, so nothing below ever sees or handles a credential.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HarborClient, HarborError } from "./harbor.js";

/** Render any result as the single text block MCP tools return. */
function ok(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

/**
 * Turn a failure into a tool error the model can act on.
 *
 * `isError` rather than a thrown exception: a thrown error becomes a protocol
 * error and the model is told the tool is broken, when in fact the answer —
 * "you are not allowed to see that project" — is information it should have.
 */
function fail(err: unknown) {
  const parts: string[] = [];
  if (err instanceof HarborError) {
    parts.push(err.message);
    if (err.hint) parts.push(`\nHint: ${err.hint}`);
  } else {
    parts.push(err instanceof Error ? err.message : String(err));
  }
  return { isError: true as const, content: [{ type: "text" as const, text: parts.join("\n") }] };
}

async function run(fn: () => Promise<unknown>) {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(err);
  }
}

const paging = {
  page: z.number().int().min(1).optional().describe("1-based page number"),
  pageSize: z.number().int().min(1).max(100).optional().describe("results per page, max 100"),
};

export function registerTools(server: McpServer, harbor: HarborClient): void {
  server.registerTool(
    "harbor_whoami",
    {
      title: "Who am I in Harbor",
      description:
        "Return the Harbor user the forwarded OIDC token resolves to. Use this " +
        "first when anything returns 401 or 403 — it distinguishes 'the token " +
        "never arrived' from 'the token arrived but this user lacks access'.",
      inputSchema: {},
    },
    async () => run(() => harbor.whoami()),
  );

  server.registerTool(
    "harbor_list_projects",
    {
      title: "List Harbor projects",
      description:
        "List the projects visible to the calling user. Harbor filters this by " +
        "the caller's own membership, so the result is already scoped to them.",
      inputSchema: {
        ...paging,
        name: z.string().optional().describe("filter on project name, substring match"),
      },
    },
    async ({ page, pageSize, name }) =>
      run(() => harbor.listProjects({ page, pageSize, name })),
  );

  server.registerTool(
    "harbor_list_repositories",
    {
      title: "List repositories in a project",
      description: "List the repositories of one Harbor project.",
      inputSchema: {
        project: z.string().min(1).describe("project name, e.g. 'library'"),
        ...paging,
        q: z.string().optional().describe("Harbor query string, e.g. name=~nginx"),
      },
    },
    async ({ project, page, pageSize, q }) =>
      run(() => harbor.listRepositories(project, { page, pageSize, q })),
  );

  server.registerTool(
    "harbor_list_artifacts",
    {
      title: "List artifacts in a repository",
      description:
        "List the artifacts (images and their tags) of one repository. " +
        "`repository` is the name *after* the project: for 'library/nginx' in " +
        "project 'library', pass 'nginx'.",
      inputSchema: {
        project: z.string().min(1).describe("project name"),
        repository: z.string().min(1).describe("repository name without the project prefix"),
        ...paging,
      },
    },
    async ({ project, repository, page, pageSize }) =>
      run(() => harbor.listArtifacts(project, repository, { page, pageSize })),
  );

  server.registerTool(
    "harbor_get_artifact",
    {
      title: "Get one artifact",
      description:
        "Fetch a single artifact with its tags, labels and scan overview. " +
        "`reference` is a tag or a digest.",
      inputSchema: {
        project: z.string().min(1).describe("project name"),
        repository: z.string().min(1).describe("repository name without the project prefix"),
        reference: z.string().min(1).describe("tag such as 'latest', or a sha256: digest"),
      },
    },
    async ({ project, repository, reference }) =>
      run(() => harbor.getArtifact(project, repository, reference)),
  );

  server.registerTool(
    "harbor_search",
    {
      title: "Search Harbor",
      description: "Search projects, repositories and charts by keyword.",
      inputSchema: { q: z.string().min(1).describe("free-text keyword") },
    },
    async ({ q }) => run(() => harbor.search(q)),
  );

  server.registerTool(
    "harbor_system_info",
    {
      title: "Harbor system info",
      description:
        "General Harbor instance information: version, registry URL, auth mode. " +
        "Useful for confirming the instance really is in oidc_auth mode.",
      inputSchema: {},
    },
    async () => run(() => harbor.systemInfo()),
  );
}
