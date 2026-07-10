# AGENTS.md

Instructions for Claude Code, Codex, Jules, Amp, and other engineering agents working in this repo.

## Agent skills

### Issue tracker

Local markdown — issues and PRDs live as files under `.scratch/<feature>/`, with one issue per `issues/<NN>-<slug>.md`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — one `CONTEXT.md` plus `docs/adr/` at the repo root. See `docs/agents/domain.md`.
