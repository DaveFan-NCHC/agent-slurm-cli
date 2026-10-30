import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const archifyRoot = resolve(repositoryRoot, ".archify");
const publicRoot = resolve(repositoryRoot, "public");
const diagramRoot = resolve(publicRoot, "diagrams");
const repositoryUrlPlaceholder = "__ARCHIFY_REPOSITORY_URL__";
const repositoryLabelPlaceholder = "__ARCHIFY_REPOSITORY_LABEL__";
const repositoryRevisionPlaceholder = "__ARCHIFY_REPOSITORY_REVISION__";
const repositoryShortRevisionPlaceholder = "__ARCHIFY_REPOSITORY_SHORT_REVISION__";

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return walk(path);
    return entry.isFile() ? [path] : [];
  });
}

function assertContained(root, path, label) {
  const child = relative(root, path);
  if (!child || isAbsolute(child) || child === ".." || child.startsWith(`..${sep}`)) {
    throw new Error(`${label} must stay below ${root}.`);
  }
  return child;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function hrefFor(path) {
  return path.split(sep).map(encodeURIComponent).join("/");
}

function diagramDate(path) {
  const match = /-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(basename(dirname(path)));
  if (!match) return undefined;
  return `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}`;
}

function repositoryConfig(env = process.env) {
  const githubUrl = env.GITHUB_REPOSITORY
    ? `${env.GITHUB_SERVER_URL || "https://github.com"}/${env.GITHUB_REPOSITORY}`
    : undefined;
  const rawUrl = env.ARCHIFY_REPOSITORY_URL || env.CI_PROJECT_URL || githubUrl;
  if (!rawUrl) {
    throw new Error(
      "Set ARCHIFY_REPOSITORY_URL, or run the build in GitLab CI/GitHub Actions.",
    );
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new Error("ARCHIFY_REPOSITORY_URL must be an absolute HTTP(S) URL.");
  }
  if (!["http:", "https:"].includes(parsedUrl.protocol)
      || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
    throw new Error(
      "ARCHIFY_REPOSITORY_URL must be an HTTP(S) URL without credentials, query, or fragment.",
    );
  }

  parsedUrl.pathname = parsedUrl.pathname.replace(/\.git\/?$/, "").replace(/\/+$/, "");
  const url = parsedUrl.toString().replace(/\/$/, "");
  const inferredProvider = env.GITHUB_REPOSITORY || parsedUrl.hostname === "github.com"
    ? "github"
    : "gitlab";
  const provider = (env.ARCHIFY_REPOSITORY_PROVIDER || inferredProvider).toLowerCase();
  if (provider !== "gitlab" && provider !== "github") {
    throw new Error("ARCHIFY_REPOSITORY_PROVIDER must be gitlab or github.");
  }

  const revision = env.ARCHIFY_REPOSITORY_REVISION || env.CI_COMMIT_SHA || env.GITHUB_SHA;
  if (!revision || !/^[0-9a-f]{7,64}$/i.test(revision)) {
    throw new Error(
      "Set ARCHIFY_REPOSITORY_REVISION, or run the build in GitLab CI/GitHub Actions.",
    );
  }

  return {
    label: `${parsedUrl.host}${parsedUrl.pathname}`,
    provider,
    revision,
    url,
  };
}

function renderDiagram(sourcePath, config) {
  let html = readFileSync(sourcePath, "utf8")
    .replaceAll(repositoryUrlPlaceholder, config.url)
    .replaceAll(repositoryLabelPlaceholder, config.label)
    .replaceAll(repositoryRevisionPlaceholder, config.revision)
    .replaceAll(repositoryShortRevisionPlaceholder, config.revision.slice(0, 7));

  if (config.provider === "github") {
    html = html
      .replaceAll(`${config.url}/-/blob/`, `${config.url}/blob/`)
      .replaceAll(`${config.url}/-/tree/`, `${config.url}/tree/`)
      .replace(/#L(\d+)-(\d+)/g, "#L$1-L$2");
  }
  return html;
}

if (!existsSync(archifyRoot)) {
  throw new Error("No .archify directory was found.");
}

const candidates = walk(archifyRoot).filter((path) => basename(path) === "candidate.json");
const diagrams = candidates.map((candidatePath) => {
  const candidate = JSON.parse(readFileSync(candidatePath, "utf8"));
  const output = candidate?.meta?.output;
  if (typeof output !== "string" || !output.toLowerCase().endsWith(".html")) {
    throw new Error(`${relative(repositoryRoot, candidatePath)} has no valid meta.output HTML path.`);
  }

  const sourcePath = resolve(repositoryRoot, output);
  const sourceRelative = assertContained(archifyRoot, sourcePath, "Archify output");
  if (!existsSync(sourcePath) || !lstatSync(sourcePath).isFile()) {
    throw new Error(`Archify output is missing: ${relative(repositoryRoot, sourcePath)}`);
  }

  return {
    title: typeof candidate?.meta?.title === "string" ? candidate.meta.title : basename(sourcePath, ".html"),
    type: typeof candidate?.diagram_type === "string" ? candidate.diagram_type : "diagram",
    date: diagramDate(sourcePath),
    href: hrefFor(relative(publicRoot, resolve(diagramRoot, sourceRelative))),
    sourcePath,
    sourceRelative,
  };
}).sort((left, right) => left.type.localeCompare(right.type) || left.title.localeCompare(right.title));

if (diagrams.length === 0) {
  throw new Error("No Archify diagrams were found to publish.");
}

const repository = repositoryConfig();
rmSync(publicRoot, { recursive: true, force: true });
mkdirSync(diagramRoot, { recursive: true });
for (const diagram of diagrams) {
  const destinationPath = resolve(diagramRoot, diagram.sourceRelative);
  assertContained(diagramRoot, destinationPath, "Published diagram");
  mkdirSync(dirname(destinationPath), { recursive: true });
  writeFileSync(destinationPath, renderDiagram(diagram.sourcePath, repository), "utf8");
}

const projectName = process.env.CI_PROJECT_NAME || "agent-slurm-cli";
const cards = diagrams.map((diagram) => `
        <a class="diagram-card" href="${escapeHtml(diagram.href)}">
          <span class="diagram-type">${escapeHtml(diagram.type)}</span>
          <h2>${escapeHtml(diagram.title)}</h2>
          <p>${diagram.date ? `產生時間：${escapeHtml(diagram.date)}` : "開啟互動式圖表"}</p>
          <span class="open-label">開啟圖表 →</span>
        </a>`).join("");

const index = `<!doctype html>
<html lang="zh-Hant">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <title>${escapeHtml(projectName)}｜Archify 圖表</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        --background: #f4f7fb;
        --surface: #ffffff;
        --text: #172033;
        --muted: #61708a;
        --border: #d9e1ee;
        --accent: #2563eb;
        --shadow: 0 14px 38px rgba(25, 45, 80, 0.09);
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --background: #0c1220;
          --surface: #151e2f;
          --text: #eef4ff;
          --muted: #a7b4ca;
          --border: #2a3850;
          --accent: #75a7ff;
          --shadow: 0 14px 38px rgba(0, 0, 0, 0.28);
        }
      }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; background: var(--background); color: var(--text); }
      main { width: min(1100px, calc(100% - 40px)); margin: 0 auto; padding: 72px 0 88px; }
      header { max-width: 760px; margin-bottom: 34px; }
      .eyebrow { color: var(--accent); font-size: 0.78rem; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase; }
      h1 { margin: 10px 0 12px; font-size: clamp(2rem, 5vw, 3.3rem); line-height: 1.08; }
      header p { margin: 0; color: var(--muted); font-size: 1.05rem; line-height: 1.7; }
      .diagram-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(270px, 1fr)); gap: 20px; }
      .diagram-card {
        display: flex; min-height: 220px; flex-direction: column; padding: 24px; color: inherit;
        text-decoration: none; background: var(--surface); border: 1px solid var(--border);
        border-radius: 18px; box-shadow: var(--shadow); transition: transform 160ms ease, border-color 160ms ease;
      }
      .diagram-card:hover { transform: translateY(-3px); border-color: var(--accent); }
      .diagram-card:focus-visible { outline: 3px solid var(--accent); outline-offset: 3px; }
      .diagram-type {
        width: fit-content; padding: 5px 9px; color: var(--accent);
        background: color-mix(in srgb, var(--accent) 12%, transparent); border-radius: 999px;
        font-size: 0.74rem; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase;
      }
      h2 { margin: 20px 0 8px; font-size: 1.25rem; line-height: 1.35; }
      .diagram-card p { margin: 0; color: var(--muted); line-height: 1.55; }
      .open-label { margin-top: auto; padding-top: 24px; color: var(--accent); font-weight: 750; }
      footer { margin-top: 30px; color: var(--muted); font-size: 0.9rem; }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div class="eyebrow">Archify Diagram Library</div>
        <h1>${escapeHtml(projectName)} 圖表索引</h1>
        <p>集中查看本專案由 Archify 產生的系統架構、工作流程與其他互動式圖表。</p>
      </header>
      <section class="diagram-grid" aria-label="Archify 圖表列表">${cards}
      </section>
      <footer>共 ${diagrams.length} 張圖表，由 ${escapeHtml(repository.provider === "github" ? "GitHub Pages" : "GitLab Pages")} 自動發布。</footer>
    </main>
  </body>
</html>
`;

writeFileSync(resolve(publicRoot, "index.html"), index, "utf8");
process.stdout.write(`Published ${diagrams.length} Archify diagram(s) to ${relative(repositoryRoot, publicRoot)}.\n`);
