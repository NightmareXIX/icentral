# ICEntral

ICEntral is a multi-service academic community platform for department communication and opportunity sharing. It brings together announcements, events, achievements, job posts, alumni verification, collaboration requests, direct messaging, notifications, and moderator-managed newsletters in one web application.

This repository contains the full local development stack:

- A React + Vite frontend
- An Express-based API gateway
- Separate backend services for auth, users, posts, jobs, and chat
- Supabase-backed persistence for application data
- Optional SMTP-based newsletter delivery

## What the platform supports

- Role-based authentication for `student`, `alumni`, `faculty`, and moderator-style `admin` users
- Department feed with post types such as announcements, jobs, events, event recaps, achievements, and collaborations
- Alumni verification workflow with moderator review
- Job portal with application submission and job-owner notifications
- Event volunteer enrollment
- Collaboration posting, join requests, memberships, and notifications
- Public and private profile management with visibility controls
- Direct messaging over Socket.IO
- Search across published posts
- Moderator tools for tags, verification review, and monthly newsletter delivery

## Architecture

```text
Frontend (Vite, React, React Router)  http://localhost:5173
        |
        v
API Gateway (Express proxy)           http://localhost:5000
        |
        +--> Auth Service             http://localhost:3004
        +--> User Service             http://localhost:3001
        +--> Post Service             http://localhost:3002
        +--> Job Service              http://localhost:3003
        +--> Chat Service             http://localhost:3005
                |
                +--> Socket.IO over /chat/socket.io

All services use Supabase.
Post search and chat additionally use a direct Postgres connection.
Newsletter sending uses SMTP when configured.
```

### Service map

| Component | Port | Responsibility |
| --- | --- | --- |
| `frontend` | `5173` | End-user UI, routing, feed, dashboard, chat, moderation screens |
| `api-gateway` | `5000` | Single entry point and reverse proxy for backend services |
| `auth-service` | `3004` | Signup, login, JWT issuance |
| `user-service` | `3001` | Profiles, avatars, alumni verification, notification read state |
| `post-service` | `3002` | Feed, posts, search, comments, votes, events, collaborations, newsletters |
| `job-service` | `3003` | Job applications and job notification inbox |
| `chat-service` | `3005` | Direct messages, conversation APIs, Socket.IO transport |

## Repository structure

```text
.
|-- api-gateway/
|-- frontend/
|-- services/
|   |-- auth-service/
|   |-- user-service/
|   |-- post-service/
|   |-- job-service/
|   `-- chat-service/
|-- docker-compose.yml
|-- regi-table.sql
`-- README.md
```

## Quick start with Docker Compose

Docker Compose is the easiest way to run the full stack locally.

### 1. Prerequisites

- Docker Desktop with Compose support
- A Supabase project
- A Supabase Postgres connection string for `SUPABASE_DB_URL`
- SMTP credentials if you want newsletter delivery to actually send emails

### 2. Configure environment variables

Create or replace the root `.env` file with your own values. Do not commit real credentials.

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
SUPABASE_DB_URL=postgresql://postgres:password@host:5432/postgres

JWT_SECRET=change-this-secret

USER_SERVICE_URL=http://localhost:3001
POST_SERVICE_URL=http://localhost:3002
JOB_SERVICE_URL=http://localhost:3003
AUTH_SERVICE_URL=http://localhost:3004
CHAT_SERVICE_URL=http://localhost:3005

NEWSLETTER_APP_BASE_URL=http://localhost:5173
NEWSLETTER_TIMEZONE=Asia/Dhaka
NEWSLETTER_SCHEDULE_ENABLED=false
NEWSLETTER_SCHEDULE_INTERVAL_MS=3600000

SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
SMTP_FROM_EMAIL=
SMTP_FROM_NAME=ICentral Academic Digest
```

If you run the frontend outside Docker, you can optionally add `frontend/.env.local`:

```env
VITE_API_BASE_URL=http://localhost:5000
```

### 3. Initialize the database

Before starting the application, align the database schema in Supabase.

Run these SQL files in your Supabase SQL editor:

1. Create or align the base `public.users` table used by the services.
2. Run `services/user-service/schema.sql`
3. Run `services/post-service/schema.sql`
4. Run `services/job-service/schema.sql`
5. Run `services/chat-service/schema.sql`

Important:

- The current codebase expects a `public.users` table.
- The checked-in `regi-table.sql` looks like an older Supabase auth/profile script and does **not** fully match the current service code.
- At minimum, the current services expect `public.users` to expose fields such as `id`, `university_id`, `full_name`, `session`, `email`, `phone_number`, `role`, and `password_hash`.

### 4. Start the stack

```bash
docker compose up --build
```

Then open:

- Frontend: `http://localhost:5173`
- API Gateway health check: `http://localhost:5000/health`

## Running services without Docker

If you prefer to run each package manually, install dependencies inside each service directory and start them in separate terminals.

### Frontend

```bash
cd frontend
npm install
npm run dev
```

### API gateway

```bash
cd api-gateway
npm install
npm start
```

### Backend services

```bash
cd services/auth-service
npm install
npm start
```

```bash
cd services/user-service
npm install
npm start
```

```bash
cd services/post-service
npm install
npm start
```

```bash
cd services/job-service
npm install
npm start
```

```bash
cd services/chat-service
npm install
npm start
```

## Configuration notes

### Core environment variables

| Variable | Required | Used by | Notes |
| --- | --- | --- | --- |
| `SUPABASE_URL` | Yes | Most services | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Most services | Server-side Supabase access |
| `SUPABASE_DB_URL` | Yes for full functionality | `post-service`, `chat-service` | Needed for post search and chat database access |
| `JWT_SECRET` | Yes | Authenticated services | Must match across services |
| `VITE_API_BASE_URL` | Optional | Frontend | Defaults to `http://localhost:5000` |

### Newsletter and email

| Variable | Required | Notes |
| --- | --- | --- |
| `NEWSLETTER_SCHEDULE_ENABLED` | Optional | Set `false` in development unless you want automatic checks |
| `NEWSLETTER_SCHEDULE_INTERVAL_MS` | Optional | Scheduler poll interval |
| `NEWSLETTER_TIMEZONE` | Optional | Defaults to `Asia/Dhaka` |
| `NEWSLETTER_APP_BASE_URL` | Optional | Links used in newsletter content |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM_EMAIL`, `SMTP_FROM_NAME` | Required only for real email sending | Leave blank if you do not need newsletter delivery yet |

### Service URLs

The gateway and Compose file already default to local service URLs. You usually only need to override these when deploying outside the provided Docker setup.

## Roles and permissions

- `student`: can browse the platform, interact with posts, apply to jobs, volunteer for events, collaborate, message users, and manage their own profile
- `alumni`: can do everything a student can, and can apply for alumni verification
- `verified alumni`: can create job posts in the Job Portal after approval
- `faculty` and `admin`: treated as moderators in the codebase; can create announcements, review alumni verification requests, and access moderation/newsletter tools

## Health checks

Useful local endpoints:

- `GET /health` on the API gateway: `http://localhost:5000/health`
- `GET /health` on user service: `http://localhost:3001/health`
- `GET /health` on post service: `http://localhost:3002/health`
- `GET /health` on job service: `http://localhost:3003/health`
- `GET /` on auth service: `http://localhost:3004/`
- `GET /health` on chat service: `http://localhost:3005/health`

## Troubleshooting

### Database routes return `503`

This usually means the Supabase variables are missing or invalid. Confirm:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_DB_URL` for search/chat features

### Search or chat is degraded in Docker

Both `post-service` and `chat-service` include logic to prefer IPv4 database resolution. If you still see connection failures, use the Supabase Session Pooler connection string for `SUPABASE_DB_URL`.

### Job posting is blocked for alumni

That is expected until the alumni account has an approved verification record in `alumni_verification_applications`.

### Newsletter sending starts unexpectedly in development

Set:

```env
NEWSLETTER_SCHEDULE_ENABLED=false
```

and leave SMTP variables blank unless you explicitly want email sending enabled.

## Known gaps

- There is no checked-in root migration for the current `public.users` table expected by the services.
- `regi-table.sql` appears to be legacy and should not be treated as the full schema for the current application.
- There are no automated test suites checked into this repository yet.
- `frontend/README.md` is still the default Vite scaffold; this root README is the authoritative project overview.

## Authors

Package metadata in the repository credits:

- Dhrubo Roy Partho
- Sadnan
