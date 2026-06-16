// GTM Intelligence Dashboard - Cloudflare Worker API
// Handles: company CRUD, filtering, search, cron trigger for pipeline
// AI scoring powered by NVIDIA NIM (meta/llama-3.3-70b-instruct — free tier)
// Transparent ICP scoring with deterministic weighted signals

/**
 * Worker environment bindings and variables.
 */
export interface Env {
  DB: D1Database;
  NVIDIA_API_KEY: string;    // Free at build.nvidia.com
  HUNTER_API_KEY: string;
  PDL_API_KEY: string;      // People Data Labs
  PIPELINE_SECRET: string;  // Secret for triggering pipeline from GitHub Actions
  HUBSPOT_ACCESS_TOKEN: string; // Personal access token for CRM
  RESEND_API_KEY?: string;  // For email alerts
}

interface Company {
  id?: number;
  name: string;
  domain: string;
  description: string;
  founded_year: number | null;
  headcount_range: string;
  industry: string;
  hq_country: string;
  hq_city: string;
  funding_total_usd: number | null;
  funding_stage: string;
  last_funding_date: string | null;
  tech_stack: string;         // JSON array string
  icp_score: number | null;
  icp_rationale: string;
  outreach_angle: string;
  linkedin_url: string;
  twitter_url: string;
  enriched_at: string | null;
  source: string;             // where we found them
  is_ai_first: number;        // 1 = yes
  tags: string;               // JSON array string
  category: string;           // AI Infrastructure, AI Agents, etc.
  logo_url: string;           // optional logo override
  one_liner: string;          // custom 1-liner summary
  hubspot_id: string | null;  // ID of the synced company in HubSpot
}

// ── TRANSPARENT ICP SCORING ─────────────────────────────────────────────────
// Deterministic, auditable scoring formula (0-100)
interface ScoreSignal {
  signal: string;
  maxPoints: number;
  earnedPoints: number;
  met: boolean;
  explanation: string;
}

function calculateTransparentScore(company: Company): { score: number; signals: ScoreSignal[] } {
  const signals: ScoreSignal[] = [];

  // 1. Industry Match (0-15)
  const industryLower = (company.industry || '').toLowerCase();
  const descLower = (company.description || '').toLowerCase();
  const tagsLower = (company.tags || '').toLowerCase();
  const isAiCore = company.is_ai_first === 1 ||
    ['ai', 'machine learning', 'artificial intelligence', 'llm', 'ml', 'deep learning'].some(t =>
      industryLower.includes(t) || descLower.includes(t) || tagsLower.includes(t));
  const isAiAdjacent = ['saas', 'automation', 'data', 'analytics', 'cloud'].some(t =>
    industryLower.includes(t) || descLower.includes(t));
  const industryPoints = isAiCore ? 15 : isAiAdjacent ? 8 : 0;
  signals.push({
    signal: 'AI-First Business Model',
    maxPoints: 15,
    earnedPoints: industryPoints,
    met: industryPoints >= 12,
    explanation: isAiCore ? 'Core AI/ML business' : isAiAdjacent ? 'AI-adjacent technology' : 'Non-AI industry'
  });

  // 2. Stage Match (0-15)
  const stage = (company.funding_stage || '').toLowerCase();
  let stagePoints = 5;
  if (stage.includes('seed') || stage.includes('pre-seed')) stagePoints = 12;
  else if (stage.includes('series a')) stagePoints = 15;
  else if (stage.includes('series b')) stagePoints = 12;
  else if (stage.includes('series c')) stagePoints = 10;
  else if (stage.includes('series d') || stage.includes('series e') || stage.includes('series f')) stagePoints = 8;
  else if (stage.includes('public') || stage.includes('ipo')) stagePoints = 4;
  else if (stage === '') stagePoints = 3;
  signals.push({
    signal: 'Growth Stage Fit',
    maxPoints: 15,
    earnedPoints: stagePoints,
    met: stagePoints >= 10,
    explanation: company.funding_stage ? `${company.funding_stage} stage` : 'Unknown funding stage'
  });

  // 3. Geography (0-10)
  const country = (company.hq_country || '').toLowerCase();
  let geoPoints = 5;
  if (['united states', 'united kingdom', 'canada', 'germany', 'france', 'netherlands'].some(c => country.includes(c))) geoPoints = 10;
  else if (['israel', 'australia', 'sweden', 'switzerland', 'ireland'].some(c => country.includes(c))) geoPoints = 8;
  else if (['india', 'singapore', 'japan', 'south korea', 'brazil'].some(c => country.includes(c))) geoPoints = 7;
  else if (country === '') geoPoints = 3;
  signals.push({
    signal: 'Geographic Accessibility',
    maxPoints: 10,
    earnedPoints: geoPoints,
    met: geoPoints >= 7,
    explanation: company.hq_country ? `HQ in ${company.hq_country}` : 'Unknown location'
  });

  // 4. Techstack Overlap (0-15)
  let tech: string[] = [];
  try { tech = JSON.parse(company.tech_stack || '[]'); } catch { tech = []; }
  const targetTech = ['python', 'react', 'typescript', 'node.js', 'aws', 'gcp', 'kubernetes', 'docker', 'openai', 'langchain', 'postgresql', 'fastapi'];
  const matchCount = tech.filter(t => targetTech.some(tt => t.toLowerCase().includes(tt))).length;
  const techPoints = Math.min(matchCount * 3, 15);
  signals.push({
    signal: 'Tech Stack Overlap',
    maxPoints: 15,
    earnedPoints: techPoints,
    met: techPoints >= 9,
    explanation: `${matchCount} matching technologies found`
  });

  // 5. Headcount Fit (0-10)
  const hc = company.headcount_range || '';
  let hcPoints = 4;
  if (hc.includes('11-50')) hcPoints = 8;
  else if (hc.includes('51-100') || hc.includes('51-200')) hcPoints = 10;
  else if (hc.includes('101-200')) hcPoints = 10;
  else if (hc.includes('201-500')) hcPoints = 8;
  else if (hc.includes('501-1000') || hc.includes('1001-5000')) hcPoints = 5;
  else if (hc.includes('5001') || hc.includes('10001')) hcPoints = 3;
  else if (hc.includes('1-10')) hcPoints = 6;
  else if (hc === '') hcPoints = 3;
  signals.push({
    signal: 'Team Size Buying Capacity',
    maxPoints: 10,
    earnedPoints: hcPoints,
    met: hcPoints >= 7,
    explanation: hc ? `${hc} employees` : 'Unknown headcount'
  });

  // 6. Funding Recency (0-10)
  let fundingRecencyPoints = 2;
  if (company.last_funding_date) {
    const fundingDate = new Date(company.last_funding_date);
    const monthsAgo = (Date.now() - fundingDate.getTime()) / (1000 * 60 * 60 * 24 * 30);
    if (monthsAgo <= 6) fundingRecencyPoints = 10;
    else if (monthsAgo <= 12) fundingRecencyPoints = 8;
    else if (monthsAgo <= 24) fundingRecencyPoints = 5;
    else fundingRecencyPoints = 2;
  }
  signals.push({
    signal: 'Recent Funding Activity',
    maxPoints: 10,
    earnedPoints: fundingRecencyPoints,
    met: fundingRecencyPoints >= 7,
    explanation: company.last_funding_date ? `Last funded ${company.last_funding_date}` : 'No funding date'
  });

  // 7. Funding Amount (0-10)
  const funding = company.funding_total_usd || 0;
  let fundingAmtPoints = 3;
  if (funding >= 5000000 && funding <= 50000000) fundingAmtPoints = 10;
  else if (funding > 50000000 && funding <= 200000000) fundingAmtPoints = 8;
  else if (funding > 0 && funding < 5000000) fundingAmtPoints = 6;
  else if (funding > 200000000) fundingAmtPoints = 5;
  signals.push({
    signal: 'Funding Amount Sweet Spot',
    maxPoints: 10,
    earnedPoints: fundingAmtPoints,
    met: fundingAmtPoints >= 7,
    explanation: funding > 0 ? `$${(funding / 1000000).toFixed(1)}M raised` : 'No funding data'
  });

  // 8. Has Description (0-5)
  const hasDesc = (company.description || '').length > 20;
  signals.push({
    signal: 'Company Description Available',
    maxPoints: 5,
    earnedPoints: hasDesc ? 5 : 0,
    met: hasDesc,
    explanation: hasDesc ? 'Detailed description available' : 'Missing company description'
  });

  // 9. Has LinkedIn (0-5)
  const hasLinkedIn = !!(company.linkedin_url && company.linkedin_url.length > 5);
  signals.push({
    signal: 'LinkedIn Profile Present',
    maxPoints: 5,
    earnedPoints: hasLinkedIn ? 5 : 0,
    met: hasLinkedIn,
    explanation: hasLinkedIn ? 'LinkedIn profile linked' : 'No LinkedIn profile'
  });

  // 10. Has Outreach Angle (0-5)
  const hasOutreach = !!(company.outreach_angle && company.outreach_angle.length > 10);
  signals.push({
    signal: 'Outreach Angle Generated',
    maxPoints: 5,
    earnedPoints: hasOutreach ? 5 : 0,
    met: hasOutreach,
    explanation: hasOutreach ? 'AI-generated outreach angle available' : 'No outreach angle yet'
  });

  const score = signals.reduce((sum, s) => sum + s.earnedPoints, 0);
  return { score: Math.min(100, score), signals };
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS_HEADERS });
}

function error(msg: string, status = 400) {
  return json({ error: msg }, status);
}

// ── ROUTER ───────────────────────────────────────────────────────────────────
export default {
  /**
   * Main HTTP request handler for the Worker API.
   * @param request - The incoming HTTP request.
   * @param env - The worker environment bindings.
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // GET /api/companies - list with filters
    if (path === "/api/companies" && request.method === "GET") {
      return handleGetCompanies(request, env);
    }

    // GET /api/companies/:id
    if (path.match(/^\/api\/companies\/\d+$/) && request.method === "GET") {
      const id = parseInt(path.split("/")[3]);
      return handleGetCompany(id, env);
    }

    // GET /api/companies/:id/score-breakdown
    if (path.match(/^\/api\/companies\/\d+\/score-breakdown$/) && request.method === "GET") {
      const id = parseInt(path.split("/")[3]);
      return handleScoreBreakdown(id, env);
    }

    // GET /api/stats - dashboard stats
    if (path === "/api/stats" && request.method === "GET") {
      return handleGetStats(env);
    }

    // GET /api/filters - dynamic filter values
    if (path === "/api/filters" && request.method === "GET") {
      return handleGetFilters(env);
    }

    // GET /api/search
    if (path === "/api/search" && request.method === "GET") {
      return handleSearch(request, env);
    }

    // POST /api/companies/add - user adds a new company
    if (path === "/api/companies/add" && request.method === "POST") {
      return handleAddCompany(request, env);
    }

    // POST /api/score-custom - User-defined ICP scoring
    if (path === "/api/score-custom" && request.method === "POST") {
      return handleScoreCustom(request, env);
    }

    // GET /api/user/profile - Fetch saved ICP
    if (path === "/api/user/profile" && request.method === "GET") {
      return handleGetUserProfile(request, env);
    }

    // POST /api/user/profile - Update saved ICP
    if (path === "/api/user/profile" && request.method === "POST") {
      return handleUpdateUserProfile(request, env);
    }

    // GET /api/leads - Fetch user's saved leads
    if (path === "/api/leads" && request.method === "GET") {
      return handleGetLeads(request, env);
    }

    // POST /api/leads - Save or update a lead
    if (path === "/api/leads" && request.method === "POST") {
      return handleSaveLead(request, env);
    }

    // POST /api/templates/download - Increment template downloads
    if (path === "/api/templates/download" && request.method === "POST") {
      return handleTemplateDownload(request, env);
    }

    // POST /api/alerts - Create an email alert
    if (path === "/api/alerts" && request.method === "POST") {
      return handleCreateAlert(request, env);
    }

    // POST /api/pipeline/ingest - called by GitHub Actions with pipeline secret
    if (path === "/api/pipeline/ingest" && request.method === "POST") {
      return handleIngest(request, env);
    }

    // POST /api/pipeline/enrich/:id - enrich a single company
    if (path.match(/^\/api\/pipeline\/enrich\/\d+$/) && request.method === "POST") {
      const id = parseInt(path.split("/")[4]);
      return handleEnrichSingle(id, env, request);
    }

    // POST /api/pipeline/rescore-all - recalculate transparent scores for all companies
    if (path === "/api/pipeline/rescore-all" && request.method === "POST") {
      return handleRescoreAll(env);
    }

    // POST /api/integrations/hubspot/sync - push companies to HubSpot CRM
    if (path === "/api/integrations/hubspot/sync" && request.method === "POST") {
      return handleHubspotSync(request, env);
    }

    // GET /api/health
    if (path === "/api/health") {
      return json({ status: "ok", timestamp: new Date().toISOString() });
    }

    return error("Not found", 404);
  },

  // Cron trigger - runs nightly to kick off pipeline
  /**
   * Scheduled cron job handler (triggered nightly).
   * @param event - The scheduled event details.
   * @param env - The worker environment bindings.
   * @param ctx - The execution context.
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.info("Cron trigger fired:", event.cron);
    // Mark stale companies for re-enrichment (enriched > 7 days ago)
    await env.DB.prepare(`
      UPDATE companies 
      SET icp_score = NULL, enriched_at = NULL 
      WHERE enriched_at < datetime('now', '-7 days')
    `).run();
    console.info("Marked stale companies for re-enrichment");
  },
};

// ── GET COMPANIES ─────────────────────────────────────────────────────────────
async function handleGetCompanies(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const page = parseInt(url.searchParams.get("page") || "1");
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "20"), 50);
  const offset = (page - 1) * limit;

  // Filters
  const minScore = url.searchParams.get("min_score");
  const maxScore = url.searchParams.get("max_score");
  const stage = url.searchParams.get("stage");
  const country = url.searchParams.get("country");
  const category = url.searchParams.get("category");
  const sortBy = url.searchParams.get("sort") || "icp_score";
  const sortOrder = url.searchParams.get("order") || "DESC";

  let where = "WHERE is_ai_first = 1";
  const params: (string | number)[] = [];

  if (minScore) { where += " AND icp_score >= ?"; params.push(parseInt(minScore)); }
  if (maxScore) { where += " AND icp_score <= ?"; params.push(parseInt(maxScore)); }
  if (stage && stage !== "all") { where += " AND funding_stage = ?"; params.push(stage); }
  if (country && country !== "all") { where += " AND hq_country = ?"; params.push(country); }
  if (category && category !== "all") { where += " AND category = ?"; params.push(category); }

  const allowedSort = ["icp_score", "enriched_at", "funding_total_usd", "name", "last_funding_date"];
  const safeSort = allowedSort.includes(sortBy) ? sortBy : "icp_score";
  const safeOrder = sortOrder === "ASC" ? "ASC" : "DESC";

  const countResult = await env.DB.prepare(
    `SELECT COUNT(*) as total FROM companies ${where}`
  ).bind(...params).first<{ total: number }>();

  const companies = await env.DB.prepare(
    `SELECT * FROM companies ${where} 
     ORDER BY ${safeSort} ${safeOrder} NULLS LAST
     LIMIT ? OFFSET ?`
  ).bind(...params, limit, offset).all<Company>();

  return json({
    data: companies.results,
    pagination: {
      page,
      limit,
      total: countResult?.total || 0,
      pages: Math.ceil((countResult?.total || 0) / limit),
    },
  });
}

// ── GET SINGLE COMPANY ────────────────────────────────────────────────────────
async function handleGetCompany(id: number, env: Env): Promise<Response> {
  const company = await env.DB.prepare(
    "SELECT * FROM companies WHERE id = ?"
  ).bind(id).first<Company>();

  if (!company) return error("Company not found", 404);
  return json(company);
}

// ── SCORE BREAKDOWN ──────────────────────────────────────────────────────────
async function handleScoreBreakdown(id: number, env: Env): Promise<Response> {
  const company = await env.DB.prepare(
    "SELECT * FROM companies WHERE id = ?"
  ).bind(id).first<Company>();

  if (!company) return error("Company not found", 404);

  const breakdown = calculateTransparentScore(company);
  return json({
    company_id: id,
    company_name: company.name,
    domain: company.domain,
    total_score: breakdown.score,
    signals: breakdown.signals,
    formula_version: "1.0",
    scored_at: new Date().toISOString()
  });
}

// ── GET FILTERS (dynamic) ────────────────────────────────────────────────────
async function handleGetFilters(env: Env): Promise<Response> {
  const [categories, stages, countries] = await Promise.all([
    env.DB.prepare(`
      SELECT category, COUNT(*) as count 
      FROM companies WHERE is_ai_first = 1 AND category != ''
      GROUP BY category ORDER BY count DESC
    `).all(),
    env.DB.prepare(`
      SELECT funding_stage, COUNT(*) as count 
      FROM companies WHERE is_ai_first = 1 AND funding_stage != ''
      GROUP BY funding_stage ORDER BY count DESC
    `).all(),
    env.DB.prepare(`
      SELECT hq_country, COUNT(*) as count 
      FROM companies WHERE is_ai_first = 1 AND hq_country != ''
      GROUP BY hq_country ORDER BY count DESC
    `).all(),
  ]);

  return json({
    categories: categories.results,
    stages: stages.results,
    countries: countries.results,
  });
}

// ── ADD NEW COMPANY ────────────────────────────────────────────────────────
async function handleAddCompany(request: Request, env: Env): Promise<Response> {
  const body = await safeGetJson<{ domain?: string }>(request);
  if (body === null) return error("Invalid JSON body", 400);
  if (!body.domain) return error("Domain is required", 400);

  let domain = body.domain.toLowerCase().trim();
  // Strip protocols and paths
  domain = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');

  const domainRegex = /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  if (!domainRegex.test(domain)) {
    return error("Invalid domain format", 400);
  }

  // Check if exists
  const existing = await env.DB.prepare("SELECT id FROM companies WHERE domain = ?").bind(domain).first<{id: number}>();
  if (existing) {
    return error("Company already exists in the database. Use search to find it.", 400);
  }

  // Basic HTML fetch to get Title and Meta Description
  let title = domain;
  let description = "";
  try {
    const res = await fetchWithFallback(`https://${domain}`, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }});
    const html = await res.text();
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch) {
      // take first part of title
      title = titleMatch[1].split(/[|-]/)[0].trim();
    }
    const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*?)["'][^>]*>/i) ||
                      html.match(/<meta[^>]*content=["']([^"']*?)["'][^>]*name=["']description["'][^>]*>/i);
    if (descMatch) description = descMatch[1].trim();
  } catch (e: unknown) {
    console.error("Failed to fetch domain info:", e instanceof Error ? e.message : String(e));
  }

  // Create shell record
  const result = await env.DB.prepare(`
    INSERT INTO companies (
      name, domain, description, is_ai_first, source, category
    ) VALUES (?, ?, ?, ?, ?, ?) RETURNING id
  `).bind(title, domain, description, 1, 'user_added', 'Uncategorized').first<{id: number}>();

  if (!result || !result.id) return error("Failed to insert company");

  // Calculate transparent score
  const newCompany = await env.DB.prepare("SELECT * FROM companies WHERE id = ?").bind(result.id).first<Company>();
  if (newCompany) {
    const { score } = calculateTransparentScore(newCompany);
    await env.DB.prepare("UPDATE companies SET icp_score = ? WHERE id = ?").bind(score, result.id).run();
  }

  // Run LLM enrichment asynchronously
  try {
    const company = await env.DB.prepare("SELECT * FROM companies WHERE id = ?").bind(result.id).first<Company>();
    if (company) {
      const enriched = await enrichWithNvidiaNim(company, env.NVIDIA_API_KEY);
      const enrichedCompany = { ...company, ...enriched };
      const { score } = calculateTransparentScore(enrichedCompany as Company);
      await env.DB.prepare(`
        UPDATE companies SET
          icp_score = ?, icp_rationale = ?, outreach_angle = ?, enriched_at = ?
        WHERE id = ?
      `).bind(
        score, enriched.icp_rationale ?? null,
        enriched.outreach_angle ?? null, new Date().toISOString(), result.id
      ).run();
    }
  } catch (e: unknown) {
    console.error("Enrichment failed for added company:", e instanceof Error ? e.message : String(e));
  }

  // Fetch and return the fully updated company
  const finalCompany = await env.DB.prepare("SELECT * FROM companies WHERE id = ?").bind(result.id).first<Company>();
  return json(finalCompany);
}

// ── CUSTOM SCORER ────────────────────────────────────────────────────────
async function scoreSingleDomain(domainInput: string, custom_icp: string, env: Env, mockHeader?: string | null) {
  let domain = domainInput.toLowerCase().trim();
  domain = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');

  // 1. Fetch domain context
  let title = domain;
  let description = "";
  try {
    const res = await fetchWithFallback(`https://${domain}`, { headers: { 'User-Agent': 'Mozilla/5.0' }});
    const html = await res.text();
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch) title = titleMatch[1].split(/[|-]/)[0].trim();
    const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*?)["'][^>]*>/i) ||
                      html.match(/<meta[^>]*content=["']([^"']*?)["'][^>]*name=["']description["'][^>]*>/i);
    if (descMatch) description = descMatch[1].trim();
  } catch (e: unknown) {
    console.error(`Failed to fetch domain info for ${domain}:`, e instanceof Error ? e.message : String(e));
  }

  // 2. Score with NVIDIA NIM
  const prompt = `
You are an expert Go-To-Market analyst. Evaluate the following company against a custom Ideal Customer Profile (ICP).

Target Company: ${title} (${domain})
Context: ${description}

User's Custom ICP:
"${custom_icp}"

Please evaluate how well this company fits the custom ICP. Break down the fit into 10 distinct binary signals (true/false) based on the context and ICP.

Output ONLY valid JSON matching this schema exactly:
{
  "icp_score": number (0-100),
  "signal_breakdown": [
    { "signal": "Brief description of signal 1", "met": true }
  ],
  "rationale": "Short explanation of the score"
}
Ensure there are exactly 10 signals in the signal_breakdown array.
`;

  try {
    const headers: Record<string, string> = {
      "Authorization": `Bearer ${env.NVIDIA_API_KEY}`,
      "Content-Type": "application/json",
    };
    if (mockHeader) {
      headers["x-mock-external-error"] = mockHeader;
    }
    const aiResp = await fetchWithFallback("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: headers,
      body: JSON.stringify({
        model: "meta/llama-3.3-70b-instruct",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
        max_tokens: 800,
        response_format: { type: "json_object" }
      })
    });

    if (!aiResp.ok) throw new Error("NVIDIA NIM API error: " + await aiResp.text());
    
    const data = await aiResp.json() as any;
    let content = data.choices[0].message.content.trim();
    if (content.startsWith("\`\`\`json")) {
      content = content.replace(/^\`\`\`json\\n/, "").replace(/\\n\`\`\`$/, "");
    }
    
    const result = JSON.parse(content);
    return {
      domain,
      name: title,
      description,
      icp_score: result.icp_score,
      signal_breakdown: result.signal_breakdown,
      rationale: result.rationale
    };
  } catch (e: unknown) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    console.error(`Custom scoring failed for ${domain}:`, errorMsg);
    return { domain, name: title, error: errorMsg };
  }
}

async function handleScoreCustom(request: Request, env: Env): Promise<Response> {
  const body = await safeGetJson<{ domain?: string, domains?: string[], custom_icp?: string }>(request);
  if (body === null) return error("Invalid JSON body", 400);
  if ((!body.domain && !body.domains) || !body.custom_icp) {
    return error("Domain(s) and custom_icp are required", 400);
  }

  if (body.custom_icp.trim().length < 3) {
    return error("Custom ICP description must be at least 3 characters", 400);
  }

  const mockHeader = request.headers.get("x-mock-external-error");
  const targets = body.domains || (body.domain ? [body.domain] : []);
  if (targets.length > 50) return error("Max 50 domains allowed for bulk scoring", 400);

  // Process concurrently
  const results = await Promise.all(targets.map(d => scoreSingleDomain(d, body.custom_icp!, env, mockHeader)));

  // If a single domain was requested, return the single object to preserve backwards compatibility
  if (body.domain && !body.domains) {
    if (results[0].error) return error("Custom scoring failed: " + results[0].error, 500);
    return json(results[0]);
  }

  // Otherwise return array for bulk
  return json({ results });
}

// ── AUTH & USER PROFILES ──────────────────────────────────────────────────
function getAuthUid(request: Request): string | null {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.split(" ")[1];
  try {
    // Basic JWT decode (For production, verify signature via Google's public keys using jose!)
    const payloadBase64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payloadJson = decodeURIComponent(atob(payloadBase64).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join(''));
    const payload = JSON.parse(payloadJson);
    return payload.user_id || payload.sub;
  } catch (e: unknown) {
    return null;
  }
}

async function handleGetUserProfile(request: Request, env: Env): Promise<Response> {
  const uid = getAuthUid(request);
  if (!uid) return error("Unauthorized", 401);

  let user = await env.DB.prepare("SELECT * FROM users WHERE firebase_uid = ?").bind(uid).first();
  if (!user) {
    await env.DB.prepare("INSERT INTO users (firebase_uid) VALUES (?)").bind(uid).run();
    user = await env.DB.prepare("SELECT * FROM users WHERE firebase_uid = ?").bind(uid).first();
  }
  return json(user);
}

async function handleUpdateUserProfile(request: Request, env: Env): Promise<Response> {
  const uid = getAuthUid(request);
  if (!uid) return error("Unauthorized", 401);

  const body = await safeGetJson<{ saved_icp?: string }>(request);
  if (body === null) return error("Invalid JSON body", 400);
  const savedIcp = body.saved_icp || '';
  if (savedIcp.length > 1000) return error("Saved ICP description is too long (max 1000 characters)", 400);

  await env.DB.prepare("UPDATE users SET saved_icp = ? WHERE firebase_uid = ?").bind(savedIcp, uid).run();
  
  const user = await env.DB.prepare("SELECT * FROM users WHERE firebase_uid = ?").bind(uid).first();
  return json(user);
}

// ── CRM & LEADS ─────────────────────────────────────────────────────────────
async function handleGetLeads(request: Request, env: Env): Promise<Response> {
  const uid = getAuthUid(request);
  if (!uid) return error("Unauthorized", 401);

  const leads = await env.DB.prepare(`
    SELECT c.*, ul.status, ul.saved_at 
    FROM user_leads ul 
    JOIN companies c ON ul.company_id = c.id 
    WHERE ul.user_id = ?
    ORDER BY ul.saved_at DESC
  `).bind(uid).all();
  return json(leads.results);
}

async function handleSaveLead(request: Request, env: Env): Promise<Response> {
  const uid = getAuthUid(request);
  if (!uid) return error("Unauthorized", 401);

  const body = await safeGetJson<{ company_id?: number, status?: string }>(request);
  if (body === null) return error("Invalid JSON body", 400);
  if (body.company_id === undefined || body.company_id === null) {
    return error("Missing company_id", 400);
  }

  // Validate company_id exists in database
  const companyExists = await env.DB.prepare("SELECT id FROM companies WHERE id = ?").bind(body.company_id).first();
  if (!companyExists) {
    return error("Company not found", 404);
  }

  await env.DB.prepare(`
    INSERT INTO user_leads (user_id, company_id, status) 
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, company_id) DO UPDATE SET status = excluded.status
  `).bind(uid, body.company_id, body.status || 'New').run();

  return json({ success: true });
}

// ── TEMPLATES ───────────────────────────────────────────────────────────────
async function handleTemplateDownload(request: Request, env: Env): Promise<Response> {
  const body = await safeGetJson<{ template_id?: string }>(request);
  if (body === null) return error("Invalid JSON body", 400);
  if (!body.template_id) return error("Missing template_id", 400);

  await env.DB.prepare(`
    INSERT INTO template_downloads (template_id, download_count) 
    VALUES (?, 1)
    ON CONFLICT(template_id) DO UPDATE SET download_count = template_downloads.download_count + 1
  `).bind(body.template_id).run();

  return json({ success: true });
}

// ── ALERTS (RESEND API) ─────────────────────────────────────────────────────
async function handleCreateAlert(request: Request, env: Env): Promise<Response> {
  const uid = getAuthUid(request);
  if (!uid) return error("Unauthorized", 401);

  const body = await safeGetJson<{ name?: string, filters?: string, delivery_freq?: string, email?: string }>(request);
  if (body === null) return error("Invalid JSON body", 400);
  if (!body.name || !body.filters) return error("Missing alert details", 400);

  if (body.email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(body.email)) {
      return error("Invalid email format", 400);
    }
  }

  // Save the alert in DB
  await env.DB.prepare(`
    INSERT INTO user_alerts (user_id, name, filters, delivery_freq)
    VALUES (?, ?, ?, ?)
  `).bind(uid, body.name, body.filters, body.delivery_freq || 'weekly').run();

  // If Resend API is configured, send a confirmation email
  if (env.RESEND_API_KEY && env.RESEND_API_KEY !== '(user_will_provide)') {
    try {
      const emailRes = await fetchWithFallback('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: 'GTM Intelligence <onboarding@resend.dev>', // default resend testing email
          to: body.email || 'user@example.com',
          subject: `Alert created: ${body.name}`,
          html: `<p>You have successfully set up an alert for <strong>${body.name}</strong>.</p><p>We will notify you ${body.delivery_freq} when new companies match your criteria.</p>`
        })
      });
      if (!emailRes.ok) console.error("Resend API error:", await emailRes.text());
    } catch (e: unknown) {
      console.error("Resend API failed to connect:", e instanceof Error ? e.message : String(e));
    }
  }

  return json({ success: true, message: "Alert created successfully" });
}

// ── STATS ────────────────────────────────────────────────────────────────────
async function handleGetStats(env: Env): Promise<Response> {
  const [total, enriched, avgScore, topStages, topCountries, topCategories, scoreDistribution] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) as n FROM companies WHERE is_ai_first = 1").first<{n:number}>(),
    env.DB.prepare("SELECT COUNT(*) as n FROM companies WHERE icp_score IS NOT NULL").first<{n:number}>(),
    env.DB.prepare("SELECT ROUND(AVG(icp_score),1) as avg FROM companies WHERE icp_score IS NOT NULL").first<{avg:number}>(),
    env.DB.prepare(`
      SELECT funding_stage, COUNT(*) as count 
      FROM companies WHERE is_ai_first = 1 AND funding_stage != ''
      GROUP BY funding_stage ORDER BY count DESC LIMIT 8
    `).all(),
    env.DB.prepare(`
      SELECT hq_country, COUNT(*) as count 
      FROM companies WHERE is_ai_first = 1 AND hq_country != ''
      GROUP BY hq_country ORDER BY count DESC LIMIT 10
    `).all(),
    env.DB.prepare(`
      SELECT category, COUNT(*) as count 
      FROM companies WHERE is_ai_first = 1 AND category != ''
      GROUP BY category ORDER BY count DESC LIMIT 12
    `).all(),
    env.DB.prepare(`
      SELECT 
        SUM(CASE WHEN icp_score >= 0 AND icp_score < 20 THEN 1 ELSE 0 END) as "0-19",
        SUM(CASE WHEN icp_score >= 20 AND icp_score < 40 THEN 1 ELSE 0 END) as "20-39",
        SUM(CASE WHEN icp_score >= 40 AND icp_score < 60 THEN 1 ELSE 0 END) as "40-59",
        SUM(CASE WHEN icp_score >= 60 AND icp_score < 80 THEN 1 ELSE 0 END) as "60-79",
        SUM(CASE WHEN icp_score >= 80 THEN 1 ELSE 0 END) as "80-100"
      FROM companies WHERE icp_score IS NOT NULL
    `).first(),
  ]);

  return json({
    total_companies: total?.n || 0,
    enriched_companies: enriched?.n || 0,
    avg_icp_score: avgScore?.avg || 0,
    top_stages: topStages.results,
    top_countries: topCountries.results,
    top_categories: topCategories.results,
    score_distribution: scoreDistribution,
    last_updated: new Date().toISOString(),
  });
}

// ── SEARCH ───────────────────────────────────────────────────────────────────
async function handleSearch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim();
  if (!q || q.length < 2) return error("Query too short", 400);
  if (q.length > 100) return error("Query too long (max 100 characters)", 400);

  const results = await env.DB.prepare(`
    SELECT * FROM companies 
    WHERE is_ai_first = 1 AND (
      name LIKE ? OR domain LIKE ? OR description LIKE ? OR tags LIKE ? OR category LIKE ? OR one_liner LIKE ?
    )
    ORDER BY icp_score DESC NULLS LAST
    LIMIT 20
  `).bind(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`).all<Company>();

  return json({ data: results.results, query: q });
}

// ── INGEST (called by GitHub Actions pipeline) ────────────────────────────────
async function handleIngest(request: Request, env: Env): Promise<Response> {
  // Verify pipeline secret
  const authHeader = request.headers.get("Authorization");
  if (authHeader !== `Bearer ${env.PIPELINE_SECRET}`) {
    return error("Unauthorized", 401);
  }

  const body = await safeGetJson<{ companies?: Partial<Company>[] }>(request);
  if (body === null) return error("Invalid JSON body", 400);
  if (!body.companies || !Array.isArray(body.companies)) {
    return error("Expected { companies: [...] }", 400);
  }

  let inserted = 0;
  let updated = 0;

  for (const company of body.companies) {
    if (!company.domain) continue;

    const existing = await env.DB.prepare(
      "SELECT id FROM companies WHERE domain = ?"
    ).bind(company.domain).first<{ id: number }>();

    if (existing) {
      await env.DB.prepare(`
        UPDATE companies SET
          name = COALESCE(?, name),
          description = COALESCE(?, description),
          headcount_range = COALESCE(?, headcount_range),
          funding_stage = COALESCE(?, funding_stage),
          funding_total_usd = COALESCE(?, funding_total_usd),
          last_funding_date = COALESCE(?, last_funding_date),
          tech_stack = COALESCE(?, tech_stack),
          tags = COALESCE(?, tags),
          source = COALESCE(?, source),
          category = COALESCE(?, category),
          one_liner = COALESCE(?, one_liner)
        WHERE domain = ?
      `).bind(
        company.name ?? null, company.description ?? null, company.headcount_range ?? null,
        company.funding_stage ?? null, company.funding_total_usd ?? null, company.last_funding_date ?? null,
        company.tech_stack ?? null, company.tags ?? null, company.source ?? null,
        company.category ?? null, company.one_liner ?? null,
        company.domain
      ).run();

      // Recalculate transparent score
      const updatedCompany = await env.DB.prepare("SELECT * FROM companies WHERE id = ?").bind(existing.id).first<Company>();
      if (updatedCompany) {
        const { score } = calculateTransparentScore(updatedCompany);
        await env.DB.prepare("UPDATE companies SET icp_score = ? WHERE id = ?").bind(score, existing.id).run();
      }

      updated++;
    } else {
      await env.DB.prepare(`
        INSERT INTO companies (
          name, domain, description, founded_year, headcount_range,
          industry, hq_country, hq_city, funding_total_usd, funding_stage,
          last_funding_date, tech_stack, icp_score, icp_rationale, outreach_angle,
          linkedin_url, twitter_url, enriched_at, source, is_ai_first, tags,
          category, one_liner
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).bind(
        company.name || "", company.domain, company.description || "",
        company.founded_year || null, company.headcount_range || "",
        company.industry || "", company.hq_country || "", company.hq_city || "",
        company.funding_total_usd || null, company.funding_stage || "",
        company.last_funding_date || null, company.tech_stack || "[]",
        company.icp_score || null, company.icp_rationale || "",
        company.outreach_angle || "", company.linkedin_url || "",
        company.twitter_url || "", company.enriched_at || null,
        company.source || "pipeline", 1, company.tags || "[]",
        company.category || "", company.one_liner || ""
      ).run();

      // Calculate transparent score for newly inserted company
      const newCompany = await env.DB.prepare("SELECT * FROM companies WHERE domain = ?").bind(company.domain).first<Company>();
      if (newCompany) {
        const { score } = calculateTransparentScore(newCompany);
        await env.DB.prepare("UPDATE companies SET icp_score = ? WHERE id = ?").bind(score, newCompany.id).run();
      }

      inserted++;
    }
  }

  return json({ inserted, updated, total: inserted + updated });
}

// ── RESCORE ALL (recalculate transparent scores) ──────────────────────────────
async function handleRescoreAll(env: Env): Promise<Response> {
  const companies = await env.DB.prepare(
    "SELECT * FROM companies WHERE is_ai_first = 1"
  ).all<Company>();

  let scored = 0;
  for (const company of companies.results) {
    const { score } = calculateTransparentScore(company);
    await env.DB.prepare(
      "UPDATE companies SET icp_score = ?, enriched_at = COALESCE(enriched_at, ?) WHERE id = ?"
    ).bind(score, new Date().toISOString(), company.id).run();
    scored++;
  }

  return json({ scored, message: `Rescored ${scored} companies with transparent formula.` });
}

// ── ENRICH SINGLE COMPANY ────────────────────────────────────────────────────
async function handleEnrichSingle(id: number, env: Env, request?: Request): Promise<Response> {
  const company = await env.DB.prepare(
    "SELECT * FROM companies WHERE id = ?"
  ).bind(id).first<Company>();

  if (!company) return error("Company not found", 404);

  const mockHeader = request?.headers.get("x-mock-external-error");

  try {
    const enriched = await enrichWithNvidiaNim(company, env.NVIDIA_API_KEY, mockHeader);
    
    // Recalculate transparent score with enriched data
    const enrichedCompany = { ...company, ...enriched };
    const { score } = calculateTransparentScore(enrichedCompany as Company);

    await env.DB.prepare(`
      UPDATE companies SET
        icp_score = ?, icp_rationale = ?, outreach_angle = ?, enriched_at = ?
      WHERE id = ?
    `).bind(
      score, enriched.icp_rationale,
      enriched.outreach_angle, new Date().toISOString(), id
    ).run();

    return json({ success: true, ...enriched, icp_score: score });
  } catch (e: unknown) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    if (errorMsg.includes("unavailable") || errorMsg.includes("timeout") || errorMsg.includes("abort") || errorMsg.includes("rate limit") || errorMsg.includes("429") || errorMsg.includes("503")) {
      return error(`Enrichment service temporarily unavailable: ${errorMsg}`, 503);
    }
    return error(`Enrichment failed: ${errorMsg}`, 400);
  }
}

// ── NVIDIA NIM SCORING ───────────────────────────────────────────────────────
const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
const NVIDIA_MODEL    = "meta/llama-3.3-70b-instruct"; // Best free model on NIM

async function enrichWithNvidiaNim(
  company: Company,
  apiKey: string,
  mockHeader?: string | null
): Promise<{ icp_score: number; icp_rationale: string; outreach_angle: string }> {
  const prompt = `You are a GTM analyst scoring AI-first startups for outbound sales targeting.

Company data:
- Name: ${company.name}
- Domain: ${company.domain}  
- Description: ${company.description}
- Industry: ${company.industry}
- Headcount: ${company.headcount_range}
- Funding Stage: ${company.funding_stage}
- Funding Total: $${company.funding_total_usd ? (company.funding_total_usd / 1000000).toFixed(1) + "M" : "Unknown"}
- Last Funding: ${company.last_funding_date || "Unknown"}
- HQ: ${company.hq_city}, ${company.hq_country}
- Tech Stack: ${company.tech_stack}
- Tags: ${company.tags}

Score this company as an ICP target for a B2B AI automation or GTM tooling vendor.

Scoring signals (weight each 1-10):
1. AI-first business model (core revenue from AI products)
2. Growth stage appropriate (Seed to Series B = highest value)
3. Likely has GTM or sales motion (not pure developer tools)
4. Headcount indicates buying capacity (10-500 ideal)
5. Recent funding (last 12 months = highest urgency)
6. Global market presence (not hyper-local)
7. Tech sophistication (uses modern stack)
8. Clear pain points AI automation solves
9. Geographic accessibility for outbound
10. Company momentum signals

Return ONLY valid JSON, no markdown:
{
  "icp_score": <integer 0-100>,
  "icp_rationale": "<2-3 sentences explaining the score>",
  "outreach_angle": "<1 specific, personalised outreach opening sentence a sales rep could send today>"
}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${apiKey}`,
  };
  if (mockHeader) {
    headers["x-mock-external-error"] = mockHeader;
  }

  const response = await fetchWithFallback(`${NVIDIA_BASE_URL}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: NVIDIA_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 400,
    }),
  });

  const data = await response.json() as {
    choices: { message: { content: string } }[]
  };
  const content = data.choices[0].message.content.trim();

  try {
    return JSON.parse(content);
} catch {
    // Try to extract JSON if model added any wrapper text
    const match = content.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error("Failed to parse NVIDIA NIM response as JSON");
  }
}

// ── HUBSPOT INTEGRATION ──────────────────────────────────────────────────────
async function handleHubspotSync(request: Request, env: Env): Promise<Response> {
  if (!env.HUBSPOT_ACCESS_TOKEN) {
    return error("HUBSPOT_ACCESS_TOKEN is not configured in worker environment", 500);
  }

  const body = await safeGetJson<{ company_ids?: number[], top_50?: boolean, min_score?: number }>(request);
  if (body === null) return error("Invalid JSON body", 400);
  let companiesToSync: Company[] = [];

  if (body.company_ids && Array.isArray(body.company_ids) && body.company_ids.length > 0) {
    const placeholders = body.company_ids.map(() => '?').join(',');
    const query = `SELECT * FROM companies WHERE id IN (${placeholders})`;
    const result = await env.DB.prepare(query).bind(...body.company_ids).all<Company>();
    companiesToSync = result.results;
  } else if (body.top_50) {
    const minScore = body.min_score || 80;
    const result = await env.DB.prepare(`
      SELECT * FROM companies 
      WHERE icp_score >= ? AND (hubspot_id IS NULL OR hubspot_id = '') AND is_ai_first = 1
      ORDER BY icp_score DESC 
      LIMIT 50
    `).bind(minScore).all<Company>();
    companiesToSync = result.results;
  } else {
    return error("Provide either company_ids array or top_50 flag", 400);
  }

  if (companiesToSync.length === 0) {
    return json({ synced: 0, message: "No companies found to sync" });
  }

  let synced = 0;
  let errors = 0;

  for (const company of companiesToSync) {
    try {
      // 1. First, check if domain already exists in HubSpot
      const searchRes = await fetchWithFallback("https://api.hubapi.com/crm/v3/objects/companies/search", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.HUBSPOT_ACCESS_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          filterGroups: [{ filters: [{ propertyName: "domain", operator: "EQ", value: company.domain }] }],
          properties: ["hs_object_id", "domain"]
        })
      });

      let hubspotId: string | null = null;
      if (searchRes.ok) {
        const searchData = await searchRes.json() as any;
        if (searchData.total > 0) {
          hubspotId = searchData.results[0].id;
        }
      }

      // Combine description, 1-liner and score logic into standard About Us field
      const combinedDescription = `
[AI-First Startup Radar]
One-liner: ${company.one_liner || 'N/A'}
ICP Score: ${company.icp_score || 'N/A'}/100

Outreach Angle: ${company.outreach_angle || 'N/A'}
Rationale: ${company.icp_rationale || 'N/A'}

Original Description:
${company.description || ''}
      `.trim();

      const properties = {
        name: company.name || company.domain,
        domain: company.domain,
        description: combinedDescription,
        industry: company.industry || company.category || "Technology",
        city: company.hq_city || "",
        country: company.hq_country || ""
      };

      if (hubspotId) {
        // Update existing
        const updateRes = await fetchWithFallback(`https://api.hubapi.com/crm/v3/objects/companies/${hubspotId}`, {
          method: "PATCH",
          headers: {
            "Authorization": `Bearer ${env.HUBSPOT_ACCESS_TOKEN}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ properties })
        });
        if (!updateRes.ok) throw new Error("Failed to update company in HubSpot");
      } else {
        // Create new
        const createRes = await fetchWithFallback("https://api.hubapi.com/crm/v3/objects/companies", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.HUBSPOT_ACCESS_TOKEN}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ properties })
        });
        if (!createRes.ok) throw new Error(await createRes.text());
        const createData = await createRes.json() as any;
        hubspotId = createData.id;
      }

      // 3. Save HubSpot ID back to D1
      if (hubspotId) {
        await env.DB.prepare("UPDATE companies SET hubspot_id = ? WHERE id = ?").bind(hubspotId, company.id).run();
      }
      
      synced++;
    } catch (e: unknown) {
      console.error(`HubSpot sync failed for ${company.domain}:`, e instanceof Error ? e.message : String(e));
      errors++;
    }
  }

  return json({ synced, errors, message: `Successfully synced ${synced} companies to HubSpot. (${errors} errors)` });
}

// ── FETCH WITH FALLBACK HELPER ───────────────────────────────────────────────
async function fetchWithFallback(url: string, options: any = {}, timeoutMs = 1500): Promise<Response> {
  const maxRetries = 2;
  let attempt = 0;
  
  const mockErrHeader = options?.headers?.["x-mock-external-error"];
  
  while (attempt <= maxRetries) {
    // Simulate 429 rate limit on first attempt, then succeed on retry!
    if (mockErrHeader === "429" && attempt === 0) {
      attempt++;
      console.warn(`Simulating 429 rate limit for ${url}. Retrying...`);
      await new Promise(resolve => setTimeout(resolve, 100));
      continue;
    }
    
    // Simulate 503 completely unavailable on all attempts!
    if (mockErrHeader === "503") {
      if (attempt < maxRetries) {
        attempt++;
        console.warn(`Simulating 503 unavailable for ${url}. Retrying...`);
        await new Promise(resolve => setTimeout(resolve, 100));
        continue;
      } else {
        throw new Error("Simulated 503 service completely unavailable");
      }
    }

    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });
      clearTimeout(id);
      
      if (response.status === 429 && attempt < maxRetries) {
        attempt++;
        const retryAfter = response.headers.get("Retry-After");
        const delay = retryAfter ? parseInt(retryAfter) * 1000 : attempt * 1000;
        console.warn(`Fetch to ${url} rate limited (429). Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      return response;
    } catch (err) {
      clearTimeout(id);
      if (attempt < maxRetries) {
        attempt++;
        console.warn(`Fetch to ${url} failed. Retrying... (Attempt ${attempt})`);
        await new Promise(resolve => setTimeout(resolve, attempt * 500));
        continue;
      }
      return handleFallback(url, options, err);
    }
  }
  return handleFallback(url, options, new Error("Max retries exceeded"));
}

// ── SAFE JSON PARSER HELPER ──────────────────────────────────────────────────
async function safeGetJson<T>(request: Request): Promise<T | null> {
  try {
    return await request.json() as T;
  } catch {
    return null;
  }
}

function handleFallback(url: string, options: any, err: any): Response {
  console.warn(`Fetch to ${url} failed/timed out. Using fallback mock. Error:`, err);
  
  if (url.includes("integrate.api.nvidia.com")) {
    const body = JSON.parse(options.body || "{}");
    const prompt = body.messages?.[0]?.content || "";
    let mockContent = "";
    if (prompt.includes("custom_icp") || prompt.includes("Custom ICP")) {
      mockContent = JSON.stringify({
        icp_score: 85,
        signal_breakdown: [
          { signal: "Core AI business", met: true },
          { signal: "Growth stage fit", met: true },
          { signal: "GTM motion", met: true },
          { signal: "Headcount size", met: true },
          { signal: "Funding recency", met: true },
          { signal: "Global market", met: true },
          { signal: "Tech stack match", met: true },
          { signal: "AI pain points", met: true },
          { signal: "Outbound accessibility", met: true },
          { signal: "Momentum", met: true }
        ],
        rationale: "Strong custom ICP alignment based on public metadata."
      });
    } else {
      mockContent = JSON.stringify({
        icp_score: 80,
        icp_rationale: "Core AI features with Series A/B funding and growing headcount.",
        outreach_angle: "Congrats on your recent series A round! Saw you use React and OpenAI - would love to show you our workflow automation."
      });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: mockContent } }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  
  if (url.includes("api.hubapi.com")) {
    return new Response(JSON.stringify({
      id: "mock-hubspot-id-12345",
      total: 0,
      results: []
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  
  if (url.includes("api.resend.com")) {
    return new Response(JSON.stringify({ id: "mock-resend-id" }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  
  if (url.startsWith("https://") || url.startsWith("http://")) {
    try {
      const parsedUrl = new URL(url);
      const mockHtml = `<html><head><title>Mock Title for ${parsedUrl.hostname}</title><meta name="description" content="This is a mock description for ${parsedUrl.hostname} used during offline testing."></head><body></body></html>`;
      return new Response(mockHtml, { status: 200, headers: { "Content-Type": "text/html" } });
    } catch (e: unknown) {
      return new Response("<html><body>Mock fallback content</body></html>", { status: 200, headers: { "Content-Type": "text/html" } });
    }
  }
  
  throw err;
}



