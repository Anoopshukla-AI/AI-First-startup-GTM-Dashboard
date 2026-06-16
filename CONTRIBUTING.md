# Contributing to GTM Intelligence Dashboard

Thank you for your interest in contributing! We appreciate your help in building a better AI-first startup radar.

---

## Local Development Setup

To get the repository running locally, please refer to the **Local Development** and **Testing** sections of the [README.md](file:///c:/projects/gtm-dashboard/README.md).

Specifically:
1. Initialize the local D1 database:
   ```bash
   cd worker && npx wrangler d1 execute gtm-intelligence-db --local --file=schema.sql
   ```
2. Verify all compile tests pass:
   ```bash
   npx tsc --noEmit
   ```
3. Run the test suite:
   ```bash
   python tests/smoke_test.py
   ```

---

## Branch Naming Convention

We use semantic prefix naming for all development branches:
- `feature/` — for new features (e.g. `feature/hubspot-integration`)
- `fix/` — for bug fixes (e.g. `fix/ingest-type-check`)
- `chore/` — for maintenance, dependencies, or metadata (e.g. `chore/update-readme`)

---

## Pull Request Checklist

Before submitting a PR, make sure your code satisfies these conditions:
- [ ] **Tests Pass**: Run `python tests/smoke_test.py` locally and verify all checks are green.
- [ ] **Type Safety**: Verify TypeScript compiles successfully (`npx tsc --noEmit` returns zero warnings).
- [ ] **No Bare Exceptions**:
  - Python code must catch specific exception types (never generic `except:`).
  - TypeScript code must annotate catch block variables as `catch (e: unknown)` and inspect errors type-safely.
- [ ] **No Debug Prints**: Clean up all temporary debugging logs (e.g., `print()` or `console.log()`). Use structured logger calls like `console.info` or python `logging` instead.
- [ ] **Documentation**: Every public function, class, or exported interface must have a clear docstring or JSDoc comment explaining parameters and return shapes.

---

## Reporting Bugs

To report a bug, please open an Issue on GitHub:
1. Provide a clear, descriptive title.
2. Outline the steps to reproduce the issue.
3. List the expected vs. actual behavior.
4. Attach any error tracebacks or relevant logs from your console.
