# 🤖 Copilot Instructions

This page summarises the GitHub Copilot coding agent instructions for this repository. The full instructions live in [`.github/copilot-instructions.md`](https://github.com/asasin235/HYDRA/blob/main/.github/copilot-instructions.md) and are automatically loaded by GitHub Copilot.

## Build & Validate

```sh
# Lint (always run before committing)
npm run lint

# Auto-fix lint issues
npm run lint:fix

# Validate a specific agent or script
node agents/XX-name.js                  # Run agent directly
node scripts/some-script.js --test      # Test flag
node scripts/sms-reader.js --once       # One-shot mode
pm2 restart XX-name && pm2 logs XX-name # Test in PM2
```

> There is no `npm test` command — validate changes by running the specific file you changed.

## Key Conventions for Copilot

1. **ESM only** — use `import`/`export`, never `require` (except `.cjs` files)
2. **Never hardcode agent metadata** — always import from `core/registry.js`
3. **Never call LLM providers directly** — all calls go through OpenRouter
4. **Errors are non-fatal by default** — log and continue; only `validateEnv` failures are fatal
5. **Bus events are fire-and-forget** — always `.catch(() => {})` on `publish()` calls
6. **Atomic writes** — use `writeBrain()` from `core/filesystem.js`
7. **Call `validateEnv('XX-name')`** at the top of every agent file
8. **Update `README.md` changelog** with every significant commit

## Model Selection

| Use Case | Model |
|----------|-------|
| Planning / orchestration | `anthropic/claude-opus-4.6` |
| Coding / tool-heavy | `anthropic/claude-sonnet-4.6` |
| High-context summarisation | `google/gemini-2.5-pro` |
| Fast cheap tasks | `google/gemini-2.5-flash` |
| Bulk/optional agents | `mistralai/mistral-small-3.2-24b-instruct` |
| Speed-sensitive | `anthropic/claude-haiku-4.5` |

Cost rates: `core/bottleneck.js` `MODEL_RATES`

## Commit Message Format

```
type(scope): description

- Bullet list of all changes made
```

Types: `feat`, `fix`, `chore`, `refactor`, `docs`

## Related Pages

- [[Development-Guide]] — full setup and workflow
- [[Agent-Registry]] — creating and modifying agents
- [[Core-Modules]] — shared infrastructure reference
- [[Architecture]] — system design and data flows
