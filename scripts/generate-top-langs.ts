import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Octokit } from "@octokit/core";
import { paginateGraphQL } from "@octokit/plugin-paginate-graphql";

type LanguageEdge = {
  size: number;
  node: { name: string; color: string | null } | null;
};

type Repository = {
  nameWithOwner: string;
  languages: { edges: (LanguageEdge | null)[] } | null;
};

type GraphQLResponse = {
  user: {
    repositories: {
      nodes: (Repository | null)[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  } | null;
};

type Language = {
  name: string;
  color: string | null;
  size: number;
  count: number;
};

type RenderTopLanguages = (
  languages: Record<string, Language>,
  options: {
    layout: "compact";
    title_color: string;
    text_color: string;
    bg_color: string;
    hide_border: boolean;
    hide: string[];
    disable_animations: boolean;
  },
) => string;

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

const PaginatedOctokit = Octokit.plugin(paginateGraphQL);
const octokit = new PaginatedOctokit({ auth: token });
const result = await octokit.graphql.paginate<GraphQLResponse>(query, {
  login: username,
});
const repositories = result.user?.repositories.nodes.filter(
  (repo): repo is Repository => repo !== null,
) ?? [];
if (repositories.length === 0) {
  throw new Error("GitHub returned no repositories");
}
const languages = new Map<string, Language>();
let excludedByName = 0;
let excludedForSolidity = 0;

for (const repo of repositories) {
  if (excludedRepos.has(repo.nameWithOwner)) {
    excludedByName++;
    continue;
  }
  const edges =
    repo.languages?.edges?.filter(
      (edge): edge is LanguageEdge => edge !== null,
    ) ?? [];
  if (edges.some((edge) => edge.node?.name === "Solidity")) {
    excludedForSolidity++;
    continue;
  }

  for (const edge of edges) {
    const language = edge.node;
    if (!language?.name) continue;
    const previous = languages.get(language.name);
    languages.set(language.name, {
      name: language.name,
      color: language.color,
      size: (previous?.size || 0) + edge.size,
      count: (previous?.count || 0) + 1,
    });
  }
}

if (languages.size === 0) {
  throw new Error("No languages found after repository filtering");
}
const topLanguages: Record<string, Language> = Object.fromEntries(
  [...languages.entries()].sort(([, a], [, b]) => b.size - a.size),
);

// The pinned package exports the API handler, so load its renderer directly.
const { renderTopLanguages } = (await import(
  new URL(
    "./cards/top-languages.js",
    import.meta.resolve("@stats-organization/github-readme-stats-core"),
  ).href
)) as { renderTopLanguages: RenderTopLanguages };
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
