import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

function read(file) {
  const full = path.join(ROOT, file);
  return fs.existsSync(full) ? fs.readFileSync(full, "utf8") : "";
}

function assert(name, condition) {
  if (!condition) {
    console.error("❌ FAIL:", name);
    process.exitCode = 1;
    return;
  }

  console.log("✅ PASS:", name);
}

const app = read("App.tsx");
const gemini = read("src/lib/gemini.ts");
const composer = read("api/composer.ts");
const packageJson = read("package.json");
const plans = read("src/lib/elite/elite-plans.ts");
const usage = read("src/lib/elite/elite-usage.ts");
const queue = read("src/lib/elite/elite-generation-queue.ts");
const exportContract = read("src/lib/elite/elite-export-contract.ts");
const sql = read("sql/elite-market-10-schema.sql");

console.log("");
console.log("==========================================");
console.log("ELITE SMOKE TESTS");
console.log("==========================================");

assert("App.tsx existe", app.length > 1000);
assert("gemini.ts existe", gemini.length > 1000);
assert("composer.ts existe", composer.length > 1000);
assert("package.json existe", packageJson.length > 20);

assert("Tiene extractor de título", app.includes("extractBookTitleFromIdea"));
assert("Tiene extracción de capítulos", app.includes("extractChapterTitlesFromIdea"));
assert("Tiene outline_12", (app + gemini).includes("outline_12"));
assert("Tiene subheads_h2", (app + gemini).includes("subheads_h2"));

assert("No fuerza JSON para todo si hay composer de producción", composer.includes("isLongTextAction") || gemini.includes("LongAction"));
assert("Tiene safeJsonParse", (composer + gemini).includes("safeJsonParse"));

assert("Tiene planes SaaS", plans.includes("ELITE_PLANS"));
assert("Tiene pricing", plans.includes("pricing"));
assert("Tiene créditos", plans.includes("creditsPerMonth"));
assert("Tiene usage_limit", plans.includes("usage_limit"));

assert("Tiene usage_events SQL", sql.includes("usage_events"));
assert("Tiene generation_jobs SQL", sql.includes("generation_jobs"));
assert("Tiene pipeline_events SQL", sql.includes("pipeline_events"));
assert("Tiene subscription_plans SQL", sql.includes("subscription_plans"));

assert("Tiene rate limit contract", usage.includes("evaluateRateLimit"));
assert("Tiene cost estimation", usage.includes("estimateTokenCostUsd"));
assert("Tiene queue contract", queue.includes("EliteGenerationJob"));
assert("Tiene pipeline visible", queue.includes("Blueprint") && queue.includes("Fact-check") && queue.includes("Export"));

assert("Tiene export PDF", exportContract.includes("pdf"));
assert("Tiene export DOCX", exportContract.includes("docx"));
assert("Tiene export EPUB", exportContract.includes("epub"));

if (process.exitCode) {
  console.log("");
  console.log("❌ Smoke tests fallaron.");
  process.exit(process.exitCode);
}

console.log("");
console.log("✅ Todos los smoke tests pasaron.");
