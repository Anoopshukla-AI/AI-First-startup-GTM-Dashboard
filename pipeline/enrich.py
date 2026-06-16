#!/usr/bin/env python3
"""
GTM Intelligence Dashboard - Enrichment Pipeline
Runs nightly via GitHub Actions.
Fetches new AI-first startups, enriches with PDL + Hunter.io,
scores with NVIDIA NIM (meta/llama-3.3-70b-instruct — free tier),
pushes to Cloudflare Worker API.

Required environment variables (set in GitHub Actions secrets):
  NVIDIA_API_KEY      - Get free at build.nvidia.com
  PDL_API_KEY         - People Data Labs
  HUNTER_API_KEY
  WORKER_URL          - Your Cloudflare Worker URL
  PIPELINE_SECRET     - Secret for Worker API auth
"""

import os
import json
import logging
from datetime import datetime
from typing import Optional
import re
import httpx

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)
log = logging.getLogger(__name__)

# ── CONFIG ────────────────────────────────────────────────────────────────────
NVIDIA_API_KEY   = os.environ["NVIDIA_API_KEY"]   # Free at build.nvidia.com
NVIDIA_BASE_URL  = "https://integrate.api.nvidia.com/v1"
NVIDIA_MODEL     = "meta/llama-3.3-70b-instruct"  # Best free model on NIM
PDL_API_KEY      = os.environ.get("PDL_API_KEY", "")
WORKER_URL       = os.environ["WORKER_URL"].rstrip("/")
PIPELINE_SECRET  = os.environ["PIPELINE_SECRET"]

HEADERS = {"Authorization": f"Bearer {PIPELINE_SECRET}", "Content-Type": "application/json"}


# ── KNOWN AI-FIRST STARTUP SOURCES ───────────────────────────────────────────
# In production you'd pull from Crunchbase API, ProductHunt, etc.
# For free tier we use a curated list + PDL company search.
# We dynamically pull domains from HN, GitHub, and ProductHunt.


def fetch_company_from_pdl(domain: str) -> Optional[dict]:
    """Fetch company data from People Data Labs (500 free credits/month)."""
    if not PDL_API_KEY:
        return None
    try:
        resp = httpx.get(
            "https://api.peopledatalabs.com/v5/company/enrich",
            params={"website": domain, "pretty": True},
            headers={"X-Api-Key": PDL_API_KEY},
            timeout=10,
        )
        if resp.status_code == 200:
            data = resp.json()
            return {
                "name": data.get("name", ""),
                "domain": domain,
                "description": data.get("summary", ""),
                "founded_year": data.get("founded", None),
                "headcount_range": map_pdl_size(data.get("size", "")),
                "industry": data.get("industry", ""),
                "hq_country": data.get("location", {}).get("country", ""),
                "hq_city": data.get("location", {}).get("locality", ""),
                "linkedin_url": data.get("linkedin_url", ""),
                "tech_stack": json.dumps(data.get("technologies", [])[:10]),
                "tags": json.dumps(data.get("tags", [])[:8]),
            }
    except Exception as e:
        log.warning(f"PDL fetch failed for {domain}: {e}")
    return None

def fetch_basic_html_info(domain: str) -> dict:
    """Fallback: fetch basic HTML to get title and description."""
    info = {"title": domain.split(".")[0].title(), "description": ""}
    try:
        resp = httpx.get(
            f"https://{domain}",
            timeout=10,
            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"},
            follow_redirects=True
        )
        html = resp.text
        title_match = re.search(r'<title[^>]*>([^<]+)</title>', html, re.IGNORECASE)
        if title_match:
            info["title"] = title_match.group(1).split('|')[0].split('-')[0].strip()
        
        desc_match = re.search(r'<meta[^>]*name=["\']description["\'][^>]*content=["\']([^"\']*)["\'][^>]*>', html, re.IGNORECASE) or \
                     re.search(r'<meta[^>]*content=["\']([^"\']*)["\'][^>]*name=["\']description["\'][^>]*>', html, re.IGNORECASE)
        if desc_match:
            info["description"] = desc_match.group(1).strip()
    except Exception as e:
        log.warning(f"Fallback HTML fetch failed for {domain}: {e}")
    return info

def get_live_domains() -> list[str]:
    """Fetch live AI startups from HN, GitHub, and ProductHunt."""
    domains = set()
    log.info("Fetching live domains from Hacker News...")
    try:
        url = "https://hn.algolia.com/api/v1/search?query=AI&tags=(show_hn,ask_hn_who_is_hiring)"
        res = httpx.get(url, timeout=10).json()
        for hit in res.get("hits", []):
            # Parse both URLs and text blocks (e.g. Who is hiring comments)
            text = str(hit.get("url", "")) + " " + str(hit.get("story_text", "")) + " " + str(hit.get("comment_text", ""))
            urls = re.findall(r'https?://(?:www\.)?([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})', text)
            for d in urls:
                if "github.com" not in d and "ycombinator.com" not in d:
                    domains.add(d.lower())
    except Exception as e:
        log.warning(f"HN fetch failed: {e}")

    log.info("Fetching live domains from GitHub Trending...")
    try:
        url = "https://api.github.com/search/repositories?q=topic:ai+topic:machine-learning+has:readme&sort=stars&order=desc"
        res = httpx.get(url, timeout=10, headers={"User-Agent": "Mozilla/5.0"}).json()
        for item in res.get("items", [])[:30]:
            homepage = item.get("homepage")
            if homepage and "http" in homepage:
                d = homepage.split("//")[-1].split("/")[0].lower().replace("www.", "")
                if "." in d and "github.io" not in d:
                    domains.add(d)
    except Exception as e:
        log.warning(f"GitHub fetch failed: {e}")

    log.info(f"Total unique domains found: {len(domains)}")
    return list(domains)

def score_with_nvidia_nim(company: dict) -> dict:
    """Score ICP fit using NVIDIA NIM (meta/llama-3.3-70b-instruct, free tier).
    Returns score, rationale, outreach_angle."""
    prompt = f"""You are a GTM analyst scoring AI-first startups for outbound sales targeting by a B2B AI automation vendor.

Company:
- Name: {company.get('name', 'Unknown')}
- Domain: {company.get('domain', '')}
- Description: {company.get('description', 'N/A')}
- Industry: {company.get('industry', 'N/A')}
- Headcount: {company.get('headcount_range', 'N/A')}
- Funding Stage: {company.get('funding_stage', 'N/A')}
- HQ: {company.get('hq_city', '')}, {company.get('hq_country', '')}
- Tech Stack: {company.get('tech_stack', '[]')}
- Tags: {company.get('tags', '[]')}

Score as an ICP target for AI workflow automation (n8n, LangChain, agents, RAG).

Signals:
1. Core AI business (10) - Is AI their primary product?
2. Growth stage (10) - Seed-Series B = highest buying intent
3. Has GTM/sales motion (10) - Not pure open source
4. Headcount 10-500 (10) - Right buying capacity
5. Recent funding < 12 months (10) - Budget urgency
6. Global market (8) - Accessible via outbound
7. Modern tech stack (8) - Will adopt new tools
8. Clear AI automation pain points (8) - Obvious use case
9. English-speaking market (8) - Outbound accessibility
10. Momentum signals (8) - Growing fast

Return ONLY valid JSON, no markdown backticks:
{{
  "icp_score": <integer 0-100>,
  "icp_rationale": "<2 sentences: why this score, what makes them a strong or weak ICP target>",
  "outreach_angle": "<1 highly specific sentence a sales rep could open with. MUST reference a hard fact like their exact funding stage, headcount, or tech stack. NEVER use generic clichés like 'innovative', 'synergies', 'leverage', or 'delve'. Be casual and direct.>"
}}"""

    try:
        resp = httpx.post(
            f"{NVIDIA_BASE_URL}/chat/completions",
            headers={"Authorization": f"Bearer {NVIDIA_API_KEY}", "Content-Type": "application/json"},
            json={
                "model": NVIDIA_MODEL,
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0.2,
                "max_tokens": 350,
            },
            timeout=45,
        )
        content = resp.json()["choices"][0]["message"]["content"].strip()
        # Strip markdown code fences if model wraps output
        if "```" in content:
            content = content.split("```")[1]
            if content.startswith("json"):
                content = content[4:]
        return json.loads(content)
    except Exception as e:
        log.error(f"NVIDIA NIM scoring failed: {e}")
        return {"icp_score": None, "icp_rationale": "", "outreach_angle": ""}


def map_pdl_size(size_str: str) -> str:
    """Map PDL size codes to readable ranges."""
    mapping = {
        "1-10": "1-10", "11-50": "11-50", "51-200": "51-200",
        "201-500": "201-500", "501-1000": "501-1000",
        "1001-5000": "1001-5000", "5001-10000": "5001-10000",
        "10001+": "10001+",
    }
    return mapping.get(size_str, size_str)


def push_to_worker(companies: list[dict]) -> dict:
    """Push enriched companies to the Cloudflare Worker API."""
    resp = httpx.post(
        f"{WORKER_URL}/api/pipeline/ingest",
        headers=HEADERS,
        json={"companies": companies},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()

def process_domain(domain: str) -> Optional[dict]:
    """Process a single domain: enrich data, perform fallback HTML parsing, and score using NVIDIA NIM."""
    log.info(f"Processing {domain}")
    company_data = fetch_company_from_pdl(domain)
    if not company_data:
        html_info = fetch_basic_html_info(domain)
        company_data = {
            "name": html_info["title"], "domain": domain, "description": html_info["description"],
            "industry": "AI/Technology", "hq_country": "", "hq_city": "",
            "headcount_range": "", "tech_stack": "[]", "tags": "[]",
        }
    company_data["is_ai_first"] = 1
    company_data["source"] = "live_pipeline"

    try:
        scored = score_with_nvidia_nim(company_data)
        company_data["icp_score"] = scored.get("icp_score")
        company_data["icp_rationale"] = scored.get("icp_rationale", "")
        company_data["outreach_angle"] = scored.get("outreach_angle", "")
        company_data["enriched_at"] = datetime.utcnow().isoformat()
    except Exception as e:
        log.warning(f"Scoring failed for {domain}: {e}")
        return None
    return company_data

import concurrent.futures

def run_pipeline():
    """Run the nightly company search, data enrichment, and scoring pipeline end-to-end."""
    live_domains = get_live_domains()
    if not live_domains:
        log.info("No live domains found, exiting.")
        return

    log.info(f"Pipeline starting — {len(live_domains)} domains to process")
    enriched_batch = []
    
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
        future_to_domain = {executor.submit(process_domain, d): d for d in live_domains}
        for future in concurrent.futures.as_completed(future_to_domain):
            res = future.result()
            if res:
                enriched_batch.append(res)
                if len(enriched_batch) >= 10:
                    try:
                        log.info(f"Pushing batch of 10 to Worker API...")
                        push_to_worker(enriched_batch)
                    except Exception as e:
                        log.error(f"Push failed: {e}")
                    enriched_batch = []

    # Push remaining
    if enriched_batch:
        try:
            push_to_worker(enriched_batch)
            log.info(f"Pushed final batch")
        except Exception as e:
            log.error(f"Push failed: {e}")

    log.info("Pipeline complete.")


if __name__ == "__main__":
    run_pipeline()
