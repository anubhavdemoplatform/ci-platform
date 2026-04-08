#!/usr/bin/env node
// ai-agent-runner — agent.mjs
// Fetches PR context, calls the Anthropic API, posts results back to GitHub.
// Runs on Node.js 22 with built-in fetch — zero npm dependencies.

import { readFileSync, readdirSync, statSync, appendFileSync } from "node:fs";
import { join, extname } from "node:path";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// 1. Read inputs from environment variables (set by action.yml)
// ---------------------------------------------------------------------------
const config = {
  agentType: process.env.INPUT_AGENT_TYPE,
  githubToken: process.env.INPUT_GITHUB_TOKEN,
  model: process.env.INPUT_MODEL || "claude-sonnet-4-20250514",
  fallbackModel: process.env.INPUT_FALLBACK_MODEL || "claude-haiku-4-20250514",
  maxTokens: parseInt(process.env.INPUT_MAX_TOKENS || "4096", 10),
  temperature: parseFloat(process.env.INPUT_TEMPERATURE || "0.2"),
  customInstructions: process.env.INPUT_CUSTOM_INSTRUCTIONS || "",
  contextMode: process.env.INPUT_CONTEXT_MODE || "pr-diff",
  outputMode: process.env.INPUT_OUTPUT_MODE || "pr-comment",
  anthropicApiKey: process.env.INPUT_ANTHROPIC_API_KEY,
};

// GitHub context
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY; // owner/repo
const GITHUB_OUTPUT = process.env.GITHUB_OUTPUT;
const GITHUB_WORKSPACE = process.env.GITHUB_WORKSPACE || ".";
const GITHUB_EVENT_NAME = process.env.GITHUB_EVENT_NAME || "";
const eventPath = process.env.GITHUB_EVENT_PATH;
const event = eventPath ? JSON.parse(readFileSync(eventPath, "utf8")) : {};

const prNumber = event.pull_request?.number;
const [repoOwner, repoName] = (GITHUB_REPOSITORY || "/").split("/");

// ---------------------------------------------------------------------------
// 2. Helpers
// ---------------------------------------------------------------------------

/** Write a step output (handles multiline values via delimiter syntax). */
function setOutput(name, value) {
  if (!GITHUB_OUTPUT) {
    console.log(`[output] ${name} = ${String(value).substring(0, 200)}`);
    return;
  }
  const delimiter = `ghadelimiter_${randomUUID()}`;
  appendFileSync(
    GITHUB_OUTPUT,
    `${name}<<${delimiter}\n${value}\n${delimiter}\n`
  );
}

/** Make an authenticated GitHub REST API call. */
async function githubApi(endpoint, options = {}) {
  const url = endpoint.startsWith("http")
    ? endpoint
    : `https://api.github.com${endpoint}`;

  const resp = await fetch(url, {
    ...options,
    headers: {
      Authorization: `token ${config.githubToken}`,
      Accept: options.accept || "application/vnd.github.v3+json",
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`GitHub API ${resp.status} ${url}: ${body}`);
  }
  return resp;
}

// ---------------------------------------------------------------------------
// 3. Context fetching
// ---------------------------------------------------------------------------

const MAX_CONTEXT_CHARS = 150_000; // ~37 K tokens — fits comfortably in 200 K window

/** Fetch the unified diff for a pull request. */
async function fetchPrDiff() {
  const resp = await githubApi(
    `/repos/${repoOwner}/${repoName}/pulls/${prNumber}`,
    { accept: "application/vnd.github.v3.diff" }
  );
  return resp.text();
}

/** Walk the checked-out workspace and return concatenated source files. */
function readLocalRepo() {
  const SKIP_DIRS = new Set([
    ".git", "node_modules", "vendor", "dist", "build",
    "__pycache__", ".next", "coverage", ".venv", "venv",
  ]);
  const SOURCE_EXTS = new Set([
    ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx",
    ".py", ".go", ".java", ".rb", ".rs", ".c", ".cpp", ".h", ".cs", ".php",
    ".yml", ".yaml", ".json", ".toml", ".sh", ".sql",
    ".html", ".css", ".scss", ".tf", ".hcl",
  ]);
  const MAX_FILE_SIZE = 50_000; // skip individual files larger than 50 KB

  const chunks = [];
  let totalSize = 0;

  function walk(dir) {
    if (totalSize >= MAX_CONTEXT_CHARS) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
      if (totalSize >= MAX_CONTEXT_CHARS) return;
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(fullPath);
      } else if (entry.isFile() && SOURCE_EXTS.has(extname(entry.name))) {
        try {
          const stat = statSync(fullPath);
          if (stat.size > MAX_FILE_SIZE) continue;
          const content = readFileSync(fullPath, "utf8");
          const relativePath = fullPath.replace(GITHUB_WORKSPACE, "").replace(/\\/g, "/");
          const chunk = `--- ${relativePath} ---\n${content}\n`;
          chunks.push(chunk);
          totalSize += chunk.length;
        } catch { /* skip unreadable files */ }
      }
    }
  }

  walk(GITHUB_WORKSPACE);
  return chunks.join("\n");
}

/** Fetch the consumer repo's .github/ai-review-config.yml (optional). */
async function fetchRepoConfig() {
  try {
    const resp = await githubApi(
      `/repos/${repoOwner}/${repoName}/contents/.github/ai-review-config.yml`,
      { accept: "application/vnd.github.v3.raw" }
    );
    return resp.text();
  } catch {
    return null; // config is optional
  }
}

// ---------------------------------------------------------------------------
// 4. Prompt building
// ---------------------------------------------------------------------------

function buildSystemPrompt(agentType, repoConfig) {
  const prompts = {
    "code-review": `You are an expert code reviewer. Analyze the provided PR diff and give a thorough review.

Focus areas:
1. Code quality, readability, and maintainability
2. Potential bugs, race conditions, and edge cases
3. Security vulnerabilities (injection, auth flaws, data exposure)
4. Breaking changes and backward compatibility
5. Performance concerns

Format your review with clear sections. For each issue:
- State the severity: critical / high / medium / low
- Quote the relevant code
- Explain the problem
- Suggest a concrete fix

If the code is solid, say so briefly — do not invent issues.`,

    "security-scan": `You are a senior application security engineer performing a security audit. Think like an attacker.

Analyze the code for:
1. Injection vulnerabilities (SQL, command, XSS, SSTI, SSRF)
2. Authentication and authorization flaws
3. Sensitive data exposure (secrets, PII leaks, logging)
4. Insecure cryptography or randomness
5. Insecure deserialization
6. Dependency and supply-chain risks
7. Infrastructure misconfigurations
8. OWASP Top 10 coverage

For each finding:
- Severity: critical / high / medium / low
- Attack vector description
- Vulnerable code snippet
- Recommended remediation

If no issues are found, state what was checked and confirm the code appears secure.`,
  };

  let system = prompts[agentType] || "You are an AI assistant analyzing code. Provide helpful, specific feedback.";

  // Apply consumer repo config overrides
  if (repoConfig) {
    const severityMatch = repoConfig.match(/severity_threshold:\s*(\w+)/);
    if (severityMatch) {
      system += `\n\nOnly report issues at severity "${severityMatch[1]}" or higher.`;
    }

    const focusMatch = repoConfig.match(/extra_focus_areas:\n((?:\s+-\s+.+\n?)*)/);
    if (focusMatch) {
      system += `\n\nPay extra attention to:\n${focusMatch[1]}`;
    }

    const skipMatch = repoConfig.match(/skip_dirs:\n((?:\s+-\s+.+\n?)*)/);
    if (skipMatch) {
      system += `\n\nIgnore files in these directories:\n${skipMatch[1]}`;
    }
  }

  if (config.customInstructions) {
    system += `\n\nAdditional instructions:\n${config.customInstructions}`;
  }

  return system;
}

// ---------------------------------------------------------------------------
// 5. Anthropic API
// ---------------------------------------------------------------------------

async function callAnthropic(model, systemPrompt, userMessage) {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": config.anthropicApiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: config.maxTokens,
      temperature: config.temperature,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Anthropic API ${resp.status}: ${body}`);
  }

  const data = await resp.json();
  return {
    text: data.content?.[0]?.text || "",
    inputTokens: data.usage?.input_tokens || 0,
    outputTokens: data.usage?.output_tokens || 0,
  };
}

// ---------------------------------------------------------------------------
// 6. Output posting — PR comment (upserted), PR review, or GitHub issue
// ---------------------------------------------------------------------------

/** Hidden HTML comment used to identify our comments for upsert. */
function commentMarker() {
  return `<!-- ai-agent-runner:${config.agentType} -->`;
}

/** Upsert a PR comment (find existing by marker, update or create). */
async function upsertPrComment(body) {
  const marker = commentMarker();
  const markedBody = `${marker}\n${body}`;

  // Paginate through all comments to find ours
  let page = 1;
  let existingId = null;

  while (!existingId) {
    const resp = await githubApi(
      `/repos/${repoOwner}/${repoName}/issues/${prNumber}/comments?per_page=100&page=${page}`
    );
    const comments = await resp.json();
    if (comments.length === 0) break;

    const found = comments.find((c) => c.body?.includes(marker));
    if (found) existingId = found.id;
    page++;
  }

  if (existingId) {
    await githubApi(
      `/repos/${repoOwner}/${repoName}/issues/comments/${existingId}`,
      { method: "PATCH", body: JSON.stringify({ body: markedBody }) }
    );
    console.log(`Updated existing comment ${existingId}`);
  } else {
    await githubApi(
      `/repos/${repoOwner}/${repoName}/issues/${prNumber}/comments`,
      { method: "POST", body: JSON.stringify({ body: markedBody }) }
    );
    console.log("Created new comment");
  }
}

/** Submit a PR review (advisory COMMENT event — never APPROVE or REQUEST_CHANGES). */
async function submitPrReview(body) {
  const marker = commentMarker();
  await githubApi(
    `/repos/${repoOwner}/${repoName}/pulls/${prNumber}/reviews`,
    {
      method: "POST",
      body: JSON.stringify({
        body: `${marker}\n${body}`,
        event: "COMMENT",
      }),
    }
  );
  console.log("Submitted PR review");
}

/** Upsert a GitHub issue (for scheduled full-repo scans). */
async function upsertIssue(body) {
  const marker = commentMarker();
  const titles = {
    "security-scan": "Weekly AI Security Scan Report",
    "code-review": "AI Code Review Report",
  };
  const title = titles[config.agentType] || "AI Analysis Report";

  // Search for existing open issue with our marker
  const searchQuery = `repo:${repoOwner}/${repoName} is:issue is:open "${marker}" in:body`;
  const searchResp = await githubApi(
    `/search/issues?q=${encodeURIComponent(searchQuery)}`
  );
  const searchData = await searchResp.json();
  const existing = searchData.items?.[0];

  const markedBody = `${marker}\n${body}`;

  if (existing) {
    await githubApi(
      `/repos/${repoOwner}/${repoName}/issues/${existing.number}`,
      { method: "PATCH", body: JSON.stringify({ body: markedBody }) }
    );
    console.log(`Updated existing issue #${existing.number}`);
  } else {
    await githubApi(
      `/repos/${repoOwner}/${repoName}/issues`,
      {
        method: "POST",
        body: JSON.stringify({
          title,
          body: markedBody,
          labels: ["ai-scan"],
        }),
      }
    );
    console.log("Created new issue");
  }
}

// ---------------------------------------------------------------------------
// 7. Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== AI Agent Runner ===");
  console.log(`Agent type : ${config.agentType}`);
  console.log(`Model      : ${config.model}`);
  console.log(`Fallback   : ${config.fallbackModel}`);
  console.log(`Context    : ${config.contextMode}`);
  console.log(`Output     : ${config.outputMode}`);
  console.log(`PR #       : ${prNumber || "(none)"}`);

  // ---- Fetch context ----
  let context;
  if (config.contextMode === "pr-diff" && prNumber) {
    console.log(`\nFetching diff for PR #${prNumber}...`);
    context = await fetchPrDiff();
  } else if (config.contextMode === "full-repo") {
    console.log("\nReading local repo for full-repo context...");
    context = readLocalRepo();
  } else if (prNumber) {
    console.log(`\nFetching diff for PR #${prNumber} (default)...`);
    context = await fetchPrDiff();
  }

  if (!context || context.trim().length === 0) {
    console.log("No context available — skipping analysis.");
    setOutput("response", "No context available");
    setOutput("status", "skipped");
    setOutput("token-count", "0");
    return;
  }

  // Truncate oversized context
  if (context.length > MAX_CONTEXT_CHARS) {
    context = context.substring(0, MAX_CONTEXT_CHARS) +
      "\n\n[... truncated due to size ...]";
    console.log(`Context truncated to ${MAX_CONTEXT_CHARS} characters`);
  }

  console.log(`Context size: ${context.length} characters`);

  // ---- Fetch consumer config ----
  const repoConfig = await fetchRepoConfig();
  if (repoConfig) console.log("Loaded consumer repo config");

  // ---- Build prompt ----
  const systemPrompt = buildSystemPrompt(config.agentType, repoConfig);
  const userMessage = `Here is the code to analyze:\n\n\`\`\`\n${context}\n\`\`\``;

  // ---- Call Anthropic API with fallback ----
  let result;
  let status = "success";

  try {
    console.log(`\nCalling Anthropic API (${config.model})...`);
    result = await callAnthropic(config.model, systemPrompt, userMessage);
  } catch (primaryError) {
    console.log(`Primary model failed: ${primaryError.message}`);
    console.log(`Falling back to ${config.fallbackModel}...`);
    status = "fallback";

    try {
      result = await callAnthropic(config.fallbackModel, systemPrompt, userMessage);
    } catch (fallbackError) {
      console.error(`Fallback model also failed: ${fallbackError.message}`);
      setOutput("response", `AI analysis failed: ${fallbackError.message}`);
      setOutput("status", "error");
      setOutput("token-count", "0");
      return;
    }
  }

  const totalTokens = result.inputTokens + result.outputTokens;
  console.log(`\nTokens: ${result.inputTokens} in + ${result.outputTokens} out = ${totalTokens} total`);

  // ---- Format output ----
  const agentLabel = config.agentType === "code-review"
    ? "Code Review"
    : config.agentType === "security-scan"
      ? "Security Scan"
      : "Analysis";
  const modelLabel = status === "fallback"
    ? `fallback: ${config.fallbackModel}`
    : config.model;

  const formattedBody = [
    `## AI ${agentLabel} (${modelLabel})`,
    "",
    "<details>",
    `<summary>Expand AI analysis (${totalTokens} tokens used)</summary>`,
    "",
    result.text,
    "",
    "</details>",
  ].join("\n");

  // ---- Post results ----
  if (config.outputMode === "pr-review" && prNumber) {
    await submitPrReview(formattedBody);
  } else if (config.outputMode === "issue") {
    await upsertIssue(formattedBody);
  } else if (prNumber) {
    await upsertPrComment(formattedBody);
  } else {
    console.log("\nNo PR and output mode is not 'issue' — printing result to stdout:");
    console.log(result.text);
  }

  // ---- Set outputs ----
  setOutput("response", result.text.substring(0, 1000));
  setOutput("status", status);
  setOutput("token-count", String(totalTokens));

  console.log(`\nDone — status: ${status}`);
}

main().catch((err) => {
  console.error(`Fatal error: ${err.message}`);
  setOutput("response", `Error: ${err.message}`);
  setOutput("status", "error");
  setOutput("token-count", "0");
  process.exitCode = 1;
});
