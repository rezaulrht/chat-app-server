# ConvoX Server

Production-grade real-time backend for the ConvoX collaboration platform.

## Overview

ConvoX Server is a Node.js backend built on Express 5 and Socket.IO 4. It provides:

- Direct messaging and group chat
- Workspace modules (text and voice)
- Presence, typing indicators, and read status
- Feed posts, comments, tags, and social interactions
- Audio and video calling with LiveKit
- Scheduled messaging with Redis-backed coordination
- File uploads to Cloudflare R2 (S3-compatible)
- JWT auth plus Google and GitHub OAuth

The service is designed to run as a stateless API and realtime gateway, with MongoDB as source of truth and Redis as acceleration/coordination layer.

## Tech Stack

- Runtime: Node.js
- Web API: Express.js 5
- Realtime: Socket.IO 4
- Database: MongoDB (Mongoose)
- Cache and coordination: Redis
- Media and object storage: Cloudflare R2 (AWS SDK v3)
- Calling: LiveKit server SDK
- Auth: JWT, Passport (Google, GitHub)
- Email: Brevo

## Architecture At A Glance

1. API traffic enters Express routes in `index.js` and `src/routes/*`.
2. JWT-protected endpoints use `src/middleware/auth.middleware.js`.
3. Realtime traffic connects through `src/socket/handler.js` with JWT handshake auth.
4. MongoDB persists domain entities (messages, workspaces, feed, calls, WordSpy).
5. Redis is used for socket mappings, presence/typing state, and scheduled message queue locking.
6. Background scheduler (`src/utility/scheduler.js`) dispatches due scheduled messages.

## Project Structure

```text
chat-app-server/
  index.js
  src/
    config/        # Redis, Passport, R2 client
    controllers/   # Business logic for API endpoints
    middleware/    # JWT auth + access control
    models/        # Mongoose schemas
    routes/        # Express route modules
    services/      # Domain/integration services
    socket/        # Socket.IO domain handlers
    utility/       # DB connection, scheduler, email helpers
    utils/         # Misc helpers (eg LiveKit token utility)
```

## API and Socket Domains

### REST Route Groups

Mounted route groups from `index.js`:

- `/auth` - registration, login, OAuth, profile/account updates
- `/api/chat` - conversations, messages, groups, polls, read receipts
- `/api/chat/conversations/:id` - pinned message operations
- `/api/workspaces` - workspace lifecycle, invites, membership, modules
- `/api/workspaces/:workspaceId/modules` - module/channel operations
- `/api/feed` - posts, comments, tags, user feed profiles, search
- `/api/messages` - scheduled message CRUD
- `/api/calls` - call initiation, LiveKit token, voice message upload
- `/api/upload` - presign + avatar upload flows
- `/api/notifications` - notification list/read/preference operations
- `/api/user` - social link management and user profile endpoints
- `/api/wordspy` - WordSpy game REST operations
- `/api/reset` - password reset flow

Health and root endpoints:

- `GET /health` - service health, Mongo/Redis status, uptime
- `GET /` - simple server status response

### Socket.IO Event Families

Primary event families implemented under `src/socket/`:

- `message:*` - DM and group messaging lifecycle (new, react, edit, delete)
- `conversation:*` - room join/leave, conversation sync concerns
- `typing:*` and `module:typing:*` - realtime typing indicators
- `presence:*` and `presence:update` - online/offline and heartbeat
- `module:*` and `module:message:*` - workspace channel realtime operations
- `workspace:*` - workspace room membership and updates
- `call:*` - call acceptance, decline, and end flow
- `voice_channel:*` - voice channel participation updates
- `feed:*` - feed room joins and post room subscriptions
- `wordspy:*` - multiplayer game state/events

## Prerequisites

- Node.js 18+
- MongoDB instance (local or Atlas)
- Redis instance (recommended for full realtime behavior)
- LiveKit (required for call features)
- Cloudflare R2 bucket (required for upload features)

## Quick Start

```bash
cd chat-app-server
npm install
```

Create `.env` in `chat-app-server/` and set the variables from the next section.

Run in development:

```bash
npm run dev
```

Run in production:

```bash
npm start
```

## Environment Variables

The server reads environment values from `.env` using `dotenv`.

### Core Runtime

| Variable     | Required | Default                 | Purpose                                                                      |
| ------------ | -------- | ----------------------- | ---------------------------------------------------------------------------- |
| `NODE_ENV`   | No       | `development`           | Runtime mode flags.                                                          |
| `PORT`       | No       | `3000`                  | HTTP and Socket.IO listen port.                                              |
| `SITE_URL`   | Yes      | -                       | Frontend base URL used for redirects/invite/reset links and CORS allow list. |
| `BASE_URL`   | No       | `http://localhost:5000` | Base URL helper used in social link init responses.                          |
| `JWT_SECRET` | Yes      | -                       | JWT signing and verification key.                                            |

### Data and State

| Variable      | Required | Default                                    | Purpose                                                         |
| ------------- | -------- | ------------------------------------------ | --------------------------------------------------------------- |
| `MONGODB_URI` | No       | `mongodb://localhost:27017/convox-chatapp` | MongoDB connection string.                                      |
| `REDIS_URL`   | No       | `redis://localhost:6379`                   | Redis connection string for realtime state and scheduler queue. |

### Object Storage and Media

| Variable               | Required      | Default | Purpose                                                  |
| ---------------------- | ------------- | ------- | -------------------------------------------------------- |
| `R2_ACCOUNT_ID`        | Yes (uploads) | -       | Cloudflare R2 account identifier used to build endpoint. |
| `R2_ACCESS_KEY_ID`     | Yes (uploads) | -       | R2 access key.                                           |
| `R2_SECRET_ACCESS_KEY` | Yes (uploads) | -       | R2 secret key.                                           |
| `R2_BUCKET_NAME`       | Yes (uploads) | -       | Target R2 bucket for media objects.                      |
| `R2_PUBLIC_URL`        | Yes (uploads) | -       | Public base URL used to return asset URLs.               |
| `IMGBB_API_KEY`        | Optional      | -       | Used where ImgBB upload integration is enabled.          |

### OAuth and Identity

| Variable               | Required | Default | Purpose                     |
| ---------------------- | -------- | ------- | --------------------------- |
| `GOOGLE_CLIENT_ID`     | Optional | -       | Google OAuth client id.     |
| `GOOGLE_CLIENT_SECRET` | Optional | -       | Google OAuth client secret. |
| `GITHUB_CLIENT_ID`     | Optional | -       | GitHub OAuth client id.     |
| `GITHUB_CLIENT_SECRET` | Optional | -       | GitHub OAuth client secret. |

### Calls and AI

| Variable               | Required    | Default                 | Purpose                                                       |
| ---------------------- | ----------- | ----------------------- | ------------------------------------------------------------- |
| `LIVEKIT_API_KEY`      | Yes (calls) | -                       | LiveKit API key for token generation.                         |
| `LIVEKIT_API_SECRET`   | Yes (calls) | -                       | LiveKit API secret for token generation.                      |
| `LIVEKIT_URL`          | Yes (calls) | -                       | LiveKit websocket URL returned to clients.                    |
| `OPENROUTER_API_KEY`   | Optional    | -                       | AI integration key used by WordSpy/controller features.       |
| `NEXT_PUBLIC_SITE_URL` | No          | `http://localhost:3000` | Referer fallback used in WordSpy OpenRouter request metadata. |

### Email and Diagnostics

| Variable        | Required | Default | Purpose                                                        |
| --------------- | -------- | ------- | -------------------------------------------------------------- |
| `BREVO_API_KEY` | Optional | -       | Password reset and transactional email integration.            |
| `DEBUG_PERMS`   | No       | off     | Enables extra permission debugging in module controller flows. |

### Example `.env`

```env
NODE_ENV=development
PORT=5000
SITE_URL=http://localhost:3000
BASE_URL=http://localhost:5000

MONGODB_URI=mongodb://localhost:27017/convox-chatapp
REDIS_URL=redis://localhost:6379
JWT_SECRET=replace_with_strong_random_secret

R2_ACCOUNT_ID=your_r2_account_id
R2_ACCESS_KEY_ID=your_r2_access_key
R2_SECRET_ACCESS_KEY=your_r2_secret_key
R2_BUCKET_NAME=convox-media
R2_PUBLIC_URL=https://cdn.example.com

GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
GITHUB_CLIENT_ID=your_github_client_id
GITHUB_CLIENT_SECRET=your_github_client_secret

LIVEKIT_API_KEY=your_livekit_api_key
LIVEKIT_API_SECRET=your_livekit_api_secret
LIVEKIT_URL=wss://your-livekit-host

OPENROUTER_API_KEY=your_openrouter_key
BREVO_API_KEY=your_brevo_key
IMGBB_API_KEY=your_imgbb_key

DEBUG_PERMS=false
```

## NPM Scripts

| Script        | Command            | Description                            |
| ------------- | ------------------ | -------------------------------------- |
| `npm run dev` | `nodemon index.js` | Development server with auto-reload.   |
| `npm start`   | `node index.js`    | Production runtime entrypoint.         |
| `npm test`    | placeholder        | No test suite is currently configured. |

## Operational Behavior

### Startup Sequence

On process start, `index.js` does the following in order:

1. Initializes Express and Socket.IO
2. Registers all route modules
3. Connects MongoDB
4. Connects Redis
5. Starts scheduler worker
6. Starts HTTP server listener

If MongoDB connection fails, process exits with code `1`.

### Redis Degraded Mode

If Redis is unavailable, the server can still start and handle core API flows. Features that rely on Redis-backed coordination (some presence/scheduler behavior) are reduced until Redis is restored.

### Health Check

`GET /health` returns:

- overall status
- database connection status
- redis connection status
- uptime
- timestamp

This endpoint is suitable for platform health probes.

## Production Deployment Guidance

### Security Baseline

- Use a strong random `JWT_SECRET`
- Restrict `SITE_URL` to trusted frontend origins
- Keep OAuth and storage secrets in your secret manager, not source control
- Enforce HTTPS at load balancer or edge

### Scalability Baseline

- Run multiple stateless server instances behind a load balancer
- Use shared Redis for socket coordination and scheduled message locking
- Use managed MongoDB with proper indexes and backup policy
- Keep file uploads direct-to-R2 to avoid saturating API nodes

### Reliability Baseline

- Add process supervision (PM2, systemd, container orchestrator)
- Configure readiness/liveness probes using `/health`
- Capture logs centrally (JSON logging recommended)
- Monitor MongoDB latency, Redis health, and websocket connection counts

## Troubleshooting

- `Authentication error: Invalid token`: verify `JWT_SECRET` and client token format.
- LiveKit token failures: verify `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, and `LIVEKIT_URL`.
- Upload failures: verify R2 credentials, bucket, and public URL values.
- OAuth callback issues: verify provider credentials and frontend redirect target in `SITE_URL`.

## Notes

- Express CORS currently allows `SITE_URL` plus local development origin.
- DNS servers are explicitly set in Mongo DB bootstrap for Atlas SRV reliability.
- OAuth callback paths are mounted as `/auth/google/callback` and `/auth/github/callback`.
