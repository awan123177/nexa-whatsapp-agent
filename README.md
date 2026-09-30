# NEXA — WhatsApp-First Personal AI Agent

> **"Your personal AI that gets things done."**

NEXA is a production-architected, WhatsApp-first personal AI agent built with Node.js, TypeScript, Google Gemini, Playwright, and Supabase PostgreSQL.

It is **NOT** just a chatbot. NEXA understands user intent and autonomously uses structured tools, web search, controlled browser automation, long-term memory, and connected services to execute real-world tasks. For sensitive or consequential operations (payments, booking purchases, sending emails, or account modifications), NEXA automatically triggers explicit user approval before execution.

---

## 🏛️ System Architecture

```
                                  +------------------------------+
                                  |    WhatsApp User (Mobile)    |
                                  +--------------+---------------+
                                                 |
                                       (Encrypted Webhook)
                                                 v
+---------------------------------------------------------------------------------------+
|  NEXA API Gateway (Fastify + TypeScript)                                              |
|                                                                                       |
|   GET  /webhook/whatsapp       -->  Meta Hub Verification (Token & Challenge)          |
|   POST /webhook/whatsapp       -->  HMAC-SHA256 Signature Auth & Immediate 200 OK     |
|   POST /api/v1/chat            -->  Direct REST Chat / UI Interface                   |
|   GET  /health                 -->  Liveness, Readiness & Dependency Health           |
+------------------------------------------------+--------------------------------------+
                                                 |
                                                 v
+------------------------------------------------+--------------------------------------+
|  Agent Orchestrator (Core Reasoning Loop)                                            |
|                                                                                       |
|   1. Deduplication & Session Identification                                           |
|   2. Approval State Resolver (Checks for pending user 'Yes/Approve' or 'No/Cancel')   |
|   3. Memory Retrieval & User Profile Contextualization                                |
|   4. Multi-Step Execution Loop (Max steps guard, Tool Selection & Invocation)          |
|   5. Persistent Audit Trail & History Storage                                         |
+------------------------------------------------+--------------------------------------+
                                                 |
            +------------------------------------+------------------------------------+
            |                                    |                                    |
            v                                    v                                    v
+-----------------------+            +-----------------------+            +-----------------------+
|   AI Provider Layer   |            |     Tool Registry     |            |  Security & Approval  |
|                       |            |                       |            |                       |
| • Gemini Provider     |            | • web_search          |            | • Secret Redaction    |
|   (@google/genai)     |            | • browser_open/read/  |            | • Role Permissions    |
| • Model Abstraction   |            |   click/type/scroll   |            | • HMAC Verification   |
| • Fallback/Mock for   |            | • search_flights/hotel|            | • Approval Engine     |
|   Deterministic Tests |            | • send_email (approval|            | • Memory Sanitizer    |
|                       |            | • save/get_memory     |            | • Sliding Rate Limiter|
+-----------------------+            +-----------+-----------+            +-----------------------+
                                                 |
            +------------------------------------+------------------------------------+
            |                                    |                                    |
            v                                    v                                    v
+-----------------------+            +-----------------------+            +-----------------------+
|  Playwright Engine    |            |   Database Repository |            |  WhatsApp Gateway     |
|                       |            |                       |            |                       |
| • Headless Chromium   |            | • Supabase Client     |            | • Graph API v21.0     |
| • SSRF & Private IP   |            | • In-Memory Fallback  |            | • Interactive Buttons |
|   Shield              |            | • 11 Domain Tables    |            | • Read Receipts       |
| • Anti-Bot & CAPTCHA  |            | • Foreign Keys, Index |            | • Media Pipeline      |
|   Detection Guard     |            |   & Auto Timestamps   |            |   (Voice/Image/Doc)   |
+-----------------------+            +-----------------------+            +-----------------------+
```

---

## 📦 Monorepo Structure

```
├── apps/
│   └── api/                # Fastify REST & Webhook server
│       ├── src/
│       │   ├── routes/     # Health, WhatsApp webhook, and direct chat routes
│       │   ├── app.ts      # Fastify plugins, CORS, raw-body, error handlers
│       │   └── server.ts   # Bootstrap entry point
├── packages/
│   ├── shared/             # Domain models, error classes, config validation, interfaces
│   ├── security/           # Secret masking, HMAC-SHA256 verification, rate limiters, RBAC
│   ├── database/           # Supabase client, in-memory repository fallback, SQL schema
│   ├── ai/                 # GeminiProvider (@google/genai unified SDK) & MockAIProvider
│   ├── browser/            # Controlled Playwright browser service with anti-bot detection
│   ├── tools/              # Typed Tool Registry & 15+ initial tools (search, email, travel)
│   ├── agent/              # Multi-step Agent Orchestrator with memory & approval engine
│   └── whatsapp/           # Meta Cloud API client, webhook parser, media abstraction
├── tests/                  # Automated test suite with Vitest
│   ├── security.test.ts    # Redaction, HMAC signatures, anti-credential storage
│   ├── tools.test.ts       # Zod argument validation, approval flags, flight providers
│   ├── whatsapp.test.ts    # GET challenges, POST parsing, button click extraction
│   ├── agent-loop.test.ts  # Multi-step reasoning, approval pauses, user confirmations
│   └── api.test.ts         # Fastify route injections, health checks, webhook handlers
├── packages/database/schema.sql # Complete Supabase PostgreSQL migration script
├── .env.example            # Documented environment variables
└── vitest.config.ts        # Vitest test runner configuration
```

---

## 🛠️ Prerequisites

- **Node.js**: v20+ (tested on v24.14.1)
- **pnpm**: v10+ or v11+ (installed) or **npm** v10+

---

## 🚀 Quick Start (Local Development)

### 1. Clone & Install Dependencies

```bash
pnpm install
```

### 2. Configure Environment

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Edit `.env` with your credentials (see configuration section below).

> **Note:** If `GEMINI_API_KEY` or `SUPABASE_URL` are omitted during initial setup, NEXA runs in offline developer mode using the built-in `MockAIProvider` and `InMemoryRepository`.

### 3. Run Automated Tests

Execute all 24 unit and integration tests:

```bash
pnpm test
```

### 4. Build the Project

```bash
pnpm run build
```

### 5. Start the Development Server

```bash
pnpm dev
```

The server will be available at `http://localhost:3000`.

---

## 🔑 Environment Variables Reference

| Variable | Required | Description |
|---|---|---|
| `PORT` | Optional (default: `3000`) | Server HTTP port |
| `HOST` | Optional (default: `0.0.0.0`) | Server bind address |
| `LOG_LEVEL` | Optional (default: `info`) | Log level (`info`, `debug`, `warn`, `error`) |
| `GEMINI_API_KEY` | Recommended | Google Gemini API key from Google AI Studio |
| `GEMINI_MODEL` | Optional (default: `gemini-2.5-flash`) | Gemini model identifier |
| `WHATSAPP_VERIFY_TOKEN` | Required for Meta | Verification token configured in Meta App Dashboard |
| `WHATSAPP_APP_SECRET` | Required for Meta | Meta App Secret for validating webhook HMAC signatures |
| `WHATSAPP_ACCESS_TOKEN` | Required for Meta | Meta System User Access Token with `whatsapp_business_messaging` |
| `WHATSAPP_PHONE_NUMBER_ID` | Required for Meta | Phone Number ID from Meta WhatsApp Cloud API |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | Optional | WhatsApp Business Account (WABA) ID |
| `SUPABASE_URL` | Recommended | Supabase Project URL (`https://xyz.supabase.co`) |
| `SUPABASE_SERVICE_ROLE_KEY` | Recommended | Supabase Service Role Key (bypasses RLS for backend operations) |
| `SUPABASE_ANON_KEY` | Optional | Supabase Anonymous Key |
| `MAX_AGENT_STEPS` | Optional (default: `10`) | Maximum consecutive tool turns before stopping |
| `RATE_LIMIT_MAX_REQUESTS_PER_MINUTE` | Optional (default: `30`) | Rate limit per phone number |

---

## 🗄️ Database Setup (Supabase PostgreSQL)

1. Log into your [Supabase Dashboard](https://supabase.com).
2. Create a new project.
3. Open the **SQL Editor** tab from the left sidebar.
4. Copy the entire contents of [`packages/database/schema.sql`](file:///C:/Users/awanw/OneDrive/Desktop/whatsapp%20ai%20agent/packages/database/schema.sql).
5. Paste into the SQL editor and click **Run**.
6. The migration will create all 11 tables with foreign keys, indexes, and updated_at triggers:
   - `users`
   - `whatsapp_connections`
   - `activation_tokens`
   - `conversations`
   - `messages`
   - `memories`
   - `tasks`
   - `tool_calls`
   - `approvals`
   - `connected_accounts`
   - `audit_logs`
7. Copy your **Project URL** and **Service Role Key** from `Project Settings > API` into your `.env`.

---

## 🤖 Google Gemini Setup

1. Visit [Google AI Studio](https://aistudio.google.com/).
2. Click **Get API Key** and create a new key.
3. Add to your `.env`:
   ```env
   GEMINI_API_KEY=your_key_here
   GEMINI_MODEL=gemini-2.5-flash
   ```
4. NEXA uses `@google/genai` (Google's Unified Gen AI SDK), automatically formatting tools into function declarations and handling multi-turn conversational loops.

---

## 📱 Meta WhatsApp Cloud API Setup (Test Environment)

### 1. Create a Meta Developer App
1. Navigate to the [Meta for Developers Portal](https://developers.facebook.com/).
2. Create an App with type **Other** -> **Business**.
3. Under "Add products to your app", click **Set up** on **WhatsApp**.

### 2. Configure Credentials in `.env`
In the WhatsApp > API Setup screen:
- Copy the **Temporary Access Token** (or create a permanent System User Token) -> `WHATSAPP_ACCESS_TOKEN`
- Copy the **Phone Number ID** -> `WHATSAPP_PHONE_NUMBER_ID`
- Copy the **WhatsApp Business Account ID** -> `WHATSAPP_BUSINESS_ACCOUNT_ID`
- Go to App Settings > Basic and copy **App Secret** -> `WHATSAPP_APP_SECRET`
- Choose any secure string for your verification token -> `WHATSAPP_VERIFY_TOKEN`

### 3. Expose Local Server via Tunnel (e.g. ngrok or Cloudflare)
```bash
ngrok http 3000
```
Copy the HTTPS forwarding URL (e.g. `https://xxxx-xx-xx.ngrok-free.app`).

### 4. Configure Webhook in Meta Dashboard
1. Go to **WhatsApp > Configuration**.
2. Under **Webhook**, click **Edit**:
   - **Callback URL**: `https://xxxx-xx-xx.ngrok-free.app/webhook/whatsapp`
   - **Verify token**: The exact value of `WHATSAPP_VERIFY_TOKEN` from your `.env`.
3. Click **Verify and save**. Meta will issue a `GET` request to verify the token.
4. Under **Webhook fields**, click **Manage** and subscribe to **`messages`**.

### 5. Send a Test Message
1. In the WhatsApp API Setup screen, add your personal phone number to the recipient list.
2. Send a WhatsApp message to the Meta test phone number.
3. Watch NEXA process your message and reply via WhatsApp!

---

## 🔐 Google OAuth 2.0 (Gmail Integration) Setup

NEXA integrates directly with Gmail using standard OAuth 2.0. Users authorize NEXA without ever sharing their Google password.

### 1. Create Google Cloud Credentials
1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create or select a project.
3. Enable the **Gmail API** under **APIs & Services > Library**.
4. Go to **APIs & Services > OAuth consent screen**:
   - User Type: **External** (or Internal for Google Workspace).
   - Add app name, support email, and developer contact.
   - Scopes requested:
     - `https://www.googleapis.com/auth/gmail.send`
     - `https://www.googleapis.com/auth/gmail.readonly`
5. Go to **APIs & Services > Credentials** > **Create Credentials** > **OAuth client ID**:
   - Application type: **Web application**.
   - Authorized redirect URIs:
     - Local development: `http://localhost:3000/auth/google/callback`
     - Render production: `https://your-service.onrender.com/auth/google/callback`
6. Copy the **Client ID** and **Client Secret** into your `.env` or Render Dashboard.

### 2. Generate Data Encryption Key
NEXA automatically encrypts access and refresh tokens at rest with AES-256-GCM before saving them to the database. Generate a 256-bit key:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
Set the output as `ENCRYPTION_KEY` in your environment.

### 3. OAuth Flow Endpoints
- **Initiate OAuth Flow**: `GET /auth/google/start?userId=<USER_UUID>` (generates signed CSRF state with 15-minute expiry).
- **Callback Endpoint**: `GET /auth/google/callback?code=...&state=...` (exchanges code, retrieves profile, stores encrypted tokens in `connected_accounts`).
- **Disconnect / Revoke**: `POST /auth/google/disconnect` with body `{"userId": "<USER_UUID>"}` (revokes token with Google and updates database status to `revoked`).

---

## 🚀 Production Deployment on Render

NEXA is fully configured for Render as a containerized web service with Playwright Chromium support.

### Render Deployment Steps
1. Push your repository to GitHub (ensure `.env` is **NOT** committed).
2. Log in to [Render](https://dashboard.render.com/).
3. Click **New +** > **Blueprint** (or connect your repo via **Web Service** using Docker runtime).
4. Render will detect `render.yaml` and configure the service:
   - **Environment**: Docker (Node 22 Bookworm base)
   - **DockerfilePath**: `./Dockerfile`
   - **Health Check Path**: `/health`
   - **Port**: `10000` (Fastify automatically listens on `0.0.0.0` and respects `$PORT`)
5. In the Render Dashboard, fill in your production secrets under **Environment Variables**:
   - `GEMINI_API_KEY`
   - `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
   - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`
   - `ENCRYPTION_KEY`
6. Deploy! Render will build the multi-stage image, install Playwright Chromium system dependencies, and start the service.

### Verify Production Health
Once deployed, check your service health:
```bash
curl https://your-service.onrender.com/health
```
Expected response:
```json
{
  "status": "healthy",
  "service": "NEXA Agent API",
  "version": "0.1.0",
  "uptimeSeconds": 120,
  "integrations": {
    "aiProvider": "gemini",
    "whatsappConfigured": true,
    "googleOAuthConfigured": true,
    "databaseType": "SupabaseRepository"
  }
}
```

---

## 🧪 Testing the API Locally

You can test NEXA without WhatsApp using the direct chat endpoint:

### Direct Chat
```bash
curl -X POST http://localhost:3000/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"phoneNumber": "+15551234567", "name": "Awan", "message": "Remember that I prefer morning flights"}'
```

### Check Memories
```bash
curl http://localhost:3000/api/v1/memories/%2B15551234567
```

### Health Check
```bash
curl http://localhost:3000/health
```

---

## 🛡️ Security & Approval System

1. **Explicit Confirmation for Sensitive Actions**:
   Tools classified as `high_risk` (e.g., `send_email`, ticket purchases, or actions calling `request_user_confirmation`) pause the agent loop immediately.
   - An approval record is created in the database.
   - NEXA sends an interactive prompt to the user with **Approve** and **Cancel** buttons (or prompts for "Yes"/"No").
   - Execution resumes **only** when the user confirms. If the user cancels, the action is aborted.

2. **Strict Anti-Secret Memory Filters**:
   Attempting to store passwords, OTPs, PINs, card numbers, or API keys in long-term memory throws a `SecurityViolationError` and is blocked.

3. **HMAC Webhook Verification**:
   All incoming requests on `/webhook/whatsapp` are checked using `crypto.timingSafeEqual` with `X-Hub-Signature-256` and `WHATSAPP_APP_SECRET`.

4. **Browser Sandboxing & Anti-Bot Awareness**:
   Playwright enforces strict URL validation (blocks `file://`, loopback IPs, `169.254.169.254`, and private subnets). If Cloudflare or reCAPTCHA challenges are detected, NEXA informs the user instead of attempting brittle bypasses.

---

## 📈 Roadmap & Next Steps

1. **OAuth 2.0 Integrations**:
   - Google Calendar & Gmail integration.
   - Microsoft 365 / Outlook integration.
2. **Paid Travel APIs**:
   - Plug in Amadeus, Duffel, or Skyscanner GDS API into the `FlightProvider` interface.
3. **Voice Note Processing**:
   - Implement Whisper / Gemini Multimodal Audio transcription in `WhatsAppMediaService.transcribeAudio()`.
4. **Document / PDF Ingestion**:
   - Enable PDF receipt parsing and travel itinerary extraction.
5. **Background Cron Worker**:
   - Worker process to poll the `tasks` table and dispatch proactive reminder messages to WhatsApp users.
#   n e x a - w h a t s a p p - a g e n t  
 