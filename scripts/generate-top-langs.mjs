import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const username = process.env.GITHUB_REPOSITORY_OWNER || "vladfrangu";
const token = process.argv.includes("--token-stdin")
  ? readFileSync(0, "utf8").trim()
  : process.env.GITHUB_TOKEN;

if (!token) {
  throw new Error("GITHUB_TOKEN is required");
}

const excludedRepos = new Set([
  "TCDG/Scammer-Bingo-FMX",
  "TCDG/Scammer-ToolBox",
  "TCDG/Scammer-Bingo-Plus",
]);

const query = `
  query($login: String!, $cursor: String) {
    user(login: $login) {
      repositories(
        ownerAffiliations: [OWNER, ORGANIZATION_MEMBER, COLLABORATOR]
        isFork: false
        first: 100
        after: $cursor
      ) {
        nodes {
          nameWithOwner
          languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
            edges {
              size
              node { name color }
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

async function fetchRepositories() {
  const repositories = [];
  let cursor = null;

  while (true) {
    const response = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "vladfrangu-readme-stats",
      },
      body: JSON.stringify({ query, variables: { login: username, cursor } }),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      throw new Error(`GitHub GraphQL request failed: HTTP ${response.status}`);
    }

    const result = await response.json();
    if (result.errors?.length) {
      throw new Error(`GitHub GraphQL request failed: ${result.errors[0].message}`);
    }

    const connection = result.data?.user?.repositories;
    if (!connection?.nodes || !connection.pageInfo) {
      throw new Error("GitHub GraphQL returned no repositories");
    }
    repositories.push(...connection.nodes.filter(Boolean));

    if (!connection.pageInfo.hasNextPage) break;
    const nextCursor = connection.pageInfo.endCursor;
    if (!nextCursor || nextCursor === cursor) {
      throw new Error("GitHub GraphQL returned an invalid pagination cursor");
    }
    cursor = nextCursor;
  }

  return repositories;
}

const repositories = await fetchRepositories();
if (repositories.length === 0) {
  throw new Error("GitHub returned no repositories");
}
const languages = new Map();
let excludedByName = 0;
let excludedForSolidity = 0;

for (const repo of repositories) {
  if (excludedRepos.has(repo.nameWithOwner)) {
    excludedByName++;
    continue;
  }
  const edges = repo.languages?.edges?.filter(Boolean) || [];
  if (edges.some((edge) => edge.node?.name === "Solidity")) {
    excludedForSolidity++;
    continue;
  }

  for (const edge of edges) {
    const name = edge.node?.name;
    if (!name) continue;
    const previous = languages.get(name);
    languages.set(name, {
      name,
      color: edge.node.color,
      size: (previous?.size || 0) + edge.size,
      count: (previous?.count || 0) + 1,
    });
  }
}

if (languages.size === 0) {
  throw new Error("No languages found after repository filtering");
}
const topLanguages = Object.fromEntries(
  [...languages.entries()].sort(([, a], [, b]) => b.size - a.size),
);

// The pinned package exports the API handler, so load its renderer directly.
const { renderTopLanguages } = await import(
  new URL(
    "./cards/top-languages.js",
    import.meta.resolve("@stats-organization/github-readme-stats-core"),
  )
);
const svg = renderTopLanguages(topLanguages, {
  layout: "compact",
  title_color: "4F8CC9",
  text_color: "9f9f9f",
  bg_color: "151515",
  hide_border: true,
  hide: ["visual basic"],
  disable_animations: true,
});

const outputPath = path.join("profile", "top-langs.svg");
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, svg, "utf8");
console.log(
  `Generated ${outputPath} from ${repositories.length} repositories; excluded ${excludedByName} by name and ${excludedForSolidity} with Solidity`,
);
