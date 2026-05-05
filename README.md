# bellows-chat

[![CI](https://github.com/broomva/bellows-chat/actions/workflows/ci.yml/badge.svg)](https://github.com/broomva/bellows-chat/actions/workflows/ci.yml)

Chat UI for the [Bellows](https://github.com/broomva/bellows) agent harness.
A thin Next.js front-end that streams from a Bellows runtime deployed on
Railway and renders responses with the AI Elements component set.

- **Live**: https://bellows-chat.vercel.app
- **Backend**: https://bellows-production.up.railway.app (configurable via `BELLOWS_URL`)

## Stack

- Next.js 16 (App Router, Turbopack)
- AI SDK 6 + AI Elements (`@ai-sdk/react`, `streamdown`)
- React 19, TypeScript 5
- Tailwind CSS v4
- Bun 1.3 for install + scripts

## Development

```bash
bun install
bun run dev            # http://localhost:3000
```

By default the chat route proxies to the production Bellows URL. Override
with a local Bellows server:

```bash
BELLOWS_URL=http://localhost:3548 bun run dev
```

## Build

```bash
bunx tsc --noEmit      # typecheck (CI gate)
bun run build          # next build (CI gate)
```

`BELLOWS_URL` must be set at build time because the `/api/chat` route reads
it at module load.

## Deploy

Pushed to Vercel. Set `BELLOWS_URL` in the Vercel project env to point at
the corresponding Bellows deployment.
