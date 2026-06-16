import json
import urllib.request
import urllib.error
import sys

BASE_URL = "http://127.0.0.1:8787"
AUTH_TOKEN = "abc.eyJ1c2VyX2lkIjoidGVzdC11c2VyLTEyMyJ9.abc" # Fake JWT decoding to {"user_id": "test-user-123"}

def make_request(method, path, body=None, headers=None, raw_body=None):
    url = f"{BASE_URL}{path}"
    req_headers = {"Content-Type": "application/json"}
    if headers:
        req_headers.update(headers)
        
    data = None
    if raw_body is not None:
        data = raw_body.encode("utf-8")
    elif body is not None:
        data = json.dumps(body).encode("utf-8")
        
    req = urllib.request.Request(url, data=data, headers=req_headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            status = response.status
            resp_body = response.read().decode("utf-8")
            try:
                resp_json = json.loads(resp_body)
            except Exception:
                resp_json = resp_body
            return status, resp_json, None
    except urllib.error.HTTPError as e:
        status = e.code
        resp_body = e.read().decode("utf-8")
        try:
            resp_json = json.loads(resp_body)
        except Exception:
            resp_json = resp_body
        return status, resp_json, str(e)
    except Exception as e:
        return 0, None, str(e)

results_table: list[dict[str, str]] = []

def add_result(endpoint, input_data, expected, actual, status):
    results_table.append({
        "Endpoint": endpoint,
        "Input": json.dumps(input_data) if isinstance(input_data, dict) else str(input_data),
        "Expected": expected,
        "Actual": json.dumps(actual)[:60] + "..." if isinstance(actual, dict) else str(actual)[:60],
        "Status": status
    })

print("--- RUNNING STANDARD SMOKE TESTS ---")

# GET /api/health
status, resp, err = make_request("GET", "/api/health")
if status == 200 and "status" in resp and resp["status"] == "ok":
    add_result("GET /api/health", "None", "200 OK", resp, "PASS")
else:
    add_result("GET /api/health", "None", "200 OK", f"Status {status}: {resp or err}", "FAIL")

# GET /api/companies
status, resp, err = make_request("GET", "/api/companies?page=1&limit=2")
if status == 200 and "data" in resp:
    add_result("GET /api/companies", "page=1&limit=2", "200 OK", resp, "PASS")
else:
    add_result("GET /api/companies", "page=1&limit=2", "200 OK", f"Status {status}: {resp or err}", "FAIL")


print("\n--- RUNNING EDGE CASE TESTS ---")

# 1. External Service 429 Rate Limit (Retry logic succeeds)
headers = {"Authorization": f"Bearer {AUTH_TOKEN}", "x-mock-external-error": "429"}
status, resp, err = make_request("POST", "/api/pipeline/enrich/1", headers=headers)
if status == 200:
    add_result("External 429 Retry", "x-mock-external-error: 429", "200 OK (Retry Success)", resp, "PASS")
else:
    add_result("External 429 Retry", "x-mock-external-error: 429", "200 OK", f"Status {status}: {resp or err}", "FAIL")

# 2. External Service 503 Unavailable (App returns 503 not 500)
headers = {"Authorization": f"Bearer {AUTH_TOKEN}", "x-mock-external-error": "503"}
status, resp, err = make_request("POST", "/api/pipeline/enrich/1", headers=headers)
if status == 503:
    add_result("External 503 Handling", "x-mock-external-error: 503", "503 Service Unavailable", resp, "PASS")
else:
    add_result("External 503 Handling", "x-mock-external-error: 503", "503 Service Unavailable", f"Status {status}: {resp or err}", "FAIL")

# 3. Input Validation: Invalid Domain Format
status, resp, err = make_request("POST", "/api/companies/add", body={"domain": "not_a_valid_domain"})
if status == 400 and "Invalid domain format" in str(resp.get("error", "")):
    add_result("POST /api/companies/add (Invalid Domain)", "domain: not_a_valid_domain", "400 Invalid domain format", resp, "PASS")
else:
    add_result("POST /api/companies/add (Invalid Domain)", "domain: not_a_valid_domain", "400 Invalid domain format", f"Status {status}: {resp or err}", "FAIL")

# 4. Input Validation: Short Custom ICP description
status, resp, err = make_request("POST", "/api/score-custom", body={"domain": "example.com", "custom_icp": "ab"})
if status == 400 and "at least 3 characters" in str(resp.get("error", "")):
    add_result("POST /api/score-custom (Short ICP)", "custom_icp: ab", "400 Min 3 chars", resp, "PASS")
else:
    add_result("POST /api/score-custom (Short ICP)", "custom_icp: ab", "400 Min 3 chars", f"Status {status}: {resp or err}", "FAIL")

# 5. Input Validation: Saved ICP description too long
headers = {"Authorization": f"Bearer {AUTH_TOKEN}"}
status, resp, err = make_request("POST", "/api/user/profile", body={"saved_icp": "a" * 1001}, headers=headers)
if status == 400 and "too long" in str(resp.get("error", "")):
    add_result("POST /api/user/profile (Too Long ICP)", "saved_icp length 1001", "400 Too long (max 1000)", resp, "PASS")
else:
    add_result("POST /api/user/profile (Too Long ICP)", "saved_icp length 1001", "400 Too long", f"Status {status}: {resp or err}", "FAIL")

# 6. Input Validation: Non-existent Lead company_id
status, resp, err = make_request("POST", "/api/leads", body={"company_id": 999999, "status": "New"}, headers=headers)
if status == 404 and "Company not found" in str(resp.get("error", "")):
    add_result("POST /api/leads (Non-existent Company)", "company_id: 999999", "404 Company not found", resp, "PASS")
else:
    add_result("POST /api/leads (Non-existent Company)", "company_id: 999999", "404 Company not found", f"Status {status}: {resp or err}", "FAIL")

# 7. Input Validation: Invalid Email format for alerts
status, resp, err = make_request("POST", "/api/alerts", body={"name": "Alert 1", "filters": "min_score=80", "delivery_freq": "weekly", "email": "invalid_email_format"}, headers=headers)
if status == 400 and "Invalid email format" in str(resp.get("error", "")):
    add_result("POST /api/alerts (Invalid Email)", "email: invalid_email_format", "400 Invalid email format", resp, "PASS")
else:
    add_result("POST /api/alerts (Invalid Email)", "email: invalid_email_format", "400 Invalid email format", f"Status {status}: {resp or err}", "FAIL")

# 8. Input Validation: Search query too long
status, resp, err = make_request("GET", "/api/search?q=" + ("a" * 101))
if status == 400 and "Query too long" in str(resp.get("error", "")):
    add_result("GET /api/search (Query too long)", "q length 101", "400 Query too long (max 100)", resp, "PASS")
else:
    add_result("GET /api/search (Query too long)", "q length 101", "400 Query too long", f"Status {status}: {resp or err}", "FAIL")

# 9. Upstream/Module Failure: Malformed JSON payload (Returns 400 not 500)
status, resp, err = make_request("POST", "/api/companies/add", raw_body="{ malformed_json_here }")
if status == 400 and "Invalid JSON body" in str(resp.get("error", "")):
    add_result("POST /api/companies/add (Malformed JSON)", "{ malformed_json }", "400 Invalid JSON body (No 500)", resp, "PASS")
else:
    add_result("POST /api/companies/add (Malformed JSON)", "{ malformed_json }", "400 Invalid JSON body", f"Status {status}: {resp or err}", "FAIL")

# Print report
print("\n--- REPORT ---")
print(json.dumps(results_table, indent=2))

any_fail = any(r["Status"] == "FAIL" for r in results_table)
if any_fail:
    sys.exit(1)
else:
    sys.exit(0)
