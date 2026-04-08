# ci-platform

Centralized CI/CD governance platform for the `anubhavdemoplatform` GitHub organization.
Provides reusable GitHub Actions workflows and an AI-powered composite action backed by
the Anthropic API (Claude).

## Quick Start

1. Copy `caller-template/governance.yml` into your repo at `.github/workflows/governance.yml`
2. Copy `config/ai-review-config.example.yml` to `.github/ai-review-config.yml` and customize
3. Ensure the org-level `ANTHROPIC_API_KEY` secret is configured

## Components

| Component | Path | Description |
|---|---|---|
| AI Agent Runner | `actions/ai-agent-runner/` | Composite action — calls Anthropic API, posts results to PRs |
| AI Code Review | `.github/workflows/reusable-ai-code-review.yml` | Formal PR review via Claude |
| AI Security Scan | `.github/workflows/reusable-ai-security-scan.yml` | Security-focused analysis + weekly scan |
| PR Size Label | `.github/workflows/reusable-pr-size-label.yml` | Labels PRs as size/XS through size/XL |
| Maintainer Gate | `.github/workflows/reusable-maintainer-gate.yml` | Blocks merge until a named maintainer approves |
| CI Complete Gate | `.github/workflows/reusable-ci-complete-gate.yml` | Aggregates all checks into one required status |

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for full details.

## Config

Each consumer repo can customize behavior via `.github/ai-review-config.yml`.
See [config/ai-review-config.example.yml](config/ai-review-config.example.yml) for the schema.
