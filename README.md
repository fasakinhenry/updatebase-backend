# updatebase api

the backend for [updatebase](https://updatebase.app): organizations format and
publish branded updates, everyone else gets a feed worth following.

node + express 5 + typescript + mongodb. bun for local development, node on
render. every service it depends on has a free tier.

## running it

```bash
bun install
cp .env.example .env    # then fill in MONGODB_URI and the three secrets
bun run dev
```

generate the secrets with `openssl rand -base64 48`.

| script | what it does |
| --- | --- |
| `bun run dev` | watch mode on bun |
| `bun run start` | production start through tsx, which is what render runs |
| `bun run typecheck` | `tsc --noEmit` |

## how it is put together

```
src/
  config/      validated env, logger, mongo connection
  middleware/  auth, validation, rate limits, the error envelope
  models/      mongoose schemas
  routes/      one router per resource, mounted under /api
  schemas/     zod shapes shared with the client
  services/    ai providers, tokens, passwords, google verification
  types/       domain enums used across the app
  utils/       errors, response helpers, async wrapper
```

### responses

success is always `{ "data": ... }`. failure is always
`{ "error": { "code", "message", "details"? } }` with a lowercase message
written for a person, so the client can show it as is.

### auth

a short lived jwt access token in the response body, and a rotating refresh
token in an httpOnly signed cookie. only the hash of a refresh token is stored,
and presenting one that was already rotated revokes every session for that
user, since that pattern means the token was stolen.

signing up with a password and later using google lands on the same account,
matched by verified email. the reverse works too: a google account with no
password can set one and keep everything.

### ai

`src/services/ai` puts one interface in front of gemini, openai and anthropic.
pick with `AI_PROVIDER` and `AI_MODEL`, nothing else changes. gemini is the
default because its free tier needs no billing account. when no key is set the
composer falls back to deterministic formatting rather than failing.

## deploying to render

`render.yaml` is a blueprint for the free web service tier. the free instance
sleeps after 15 minutes idle, so point a free [cron-job.org](https://cron-job.org)
ping at `/api/health` every 10 minutes to keep it awake.
