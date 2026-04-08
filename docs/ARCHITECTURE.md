# CI Platform Architecture

## Overview

This repo provides a centralized CI/CD governance platform for the
`anubhavdemoplatform` GitHub organization.

## Components

### 1. `actions/ai-agent-runner/`
Composite action that calls the Anthropic API (Claude) with PR context
and posts results back to GitHub as comments or PR reviews.

### 2. `.github/workflows/`
Five reusable workflows consumed via `workflow_call`:

| Workflow | Purpose | Blocking? |
|---|---|---|
| `reusable-ai-code-review.yml` | AI-powered code review (PR Review) | No (advisory) |
| `reusable-ai-security-scan.yml` | AI security analysis + weekly scan | No (advisory) |
| `reusable-pr-size-label.yml` | Labels PRs by size (XS–XL) | No (advisory) |
| `reusable-maintainer-gate.yml` | Blocks merge until maintainer approves | **Yes** |
| `reusable-ci-complete-gate.yml` | Aggregates all checks into one status | **Yes** |

### 3. `config/`
Example configuration file for consumer repos.
Each consumer repo places `.github/ai-review-config.yml` to customize behavior.

### 4. `caller-template/`
Drop-in `governance.yml` that consumer repos copy into `.github/workflows/`.

## Consumer Repos
- `demo-api` — Python FastAPI stub
- `demo-frontend` — React stub
