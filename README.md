<div align="center">

# 🎓 LSPU KMIS

### Knowledge Management Information System

*An AI-powered knowledge platform built for Laguna State Polytechnic University*

[![Next.js](https://img.shields.io/badge/Next.js-16-black?style=for-the-badge&logo=next.js&logoColor=white)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?style=for-the-badge&logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Prisma](https://img.shields.io/badge/Prisma-6-2D3748?style=for-the-badge&logo=prisma&logoColor=white)](https://www.prisma.io/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-4-06B6D4?style=for-the-badge&logo=tailwindcss&logoColor=white)](https://tailwindcss.com/)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?style=for-the-badge&logo=docker&logoColor=white)](https://www.docker.com/)

<br />

[Features](#-features) · [Tech Stack](#%EF%B8%8F-tech-stack) · [Getting Started](#-getting-started) · [Architecture](#-architecture) · [API Reference](#-api-reference) · [Contributing](#-contributing)

<br />

</div>

---

## 📋 Overview

**LSPU KMIS** is a full-stack university knowledge management platform that centralizes document management, automates Quarterly Physical Report of Operations (QPRO) analysis using AI, and provides semantic search across institutional knowledge — all aligned with **LSPU's Strategic Plan 2025–2029**.

The system replaces fragmented spreadsheet-based KPI tracking and keyword-only search with an intelligent, role-based platform featuring **AI-powered document analysis**, **vector-based semantic search**, and **automated KRA/KPI aggregation dashboards**.

<br />

## ✨ Features

<table>
<tr>
<td width="50%">

### 📄 Document Management
- Upload, version, categorize & tag documents
- Unit-based organization (colleges/departments)
- Download & view tracking with audit trail
- Threaded comments & collaboration
- Per-document & per-unit permissions

</td>
<td width="50%">

### 🔒 Role-Based Access Control
- 4-tier hierarchy: **Admin → Faculty → Student → External**
- Granular permissions (READ / WRITE / ADMIN)
- Unit-scoped access for faculty
- JWT authentication with auto-refresh
- Edge-compatible middleware verification

</td>
</tr>
<tr>
<td width="50%">

### 🤖 AI-Powered Semantic Search
- **Colivara** vector embeddings for semantic search
- Hybrid search (semantic + keyword matching)
- AI response generation via **Qwen** & **Google Gemini**
- Chat-with-document feature
- Redis-cached results for performance

</td>
<td width="50%">

### 📊 QPRO Analysis Engine
- Router-Extractor architecture using **GPT-4o-mini**
- Automated KRA classification across 22 Key Result Areas
- Activity extraction & KPI mapping
- Prescriptive analysis generation
- Approval workflow (Draft → Approved / Rejected)

</td>
</tr>
<tr>
<td width="50%">

### 📈 KPI/KRA Aggregation Dashboard
- Type-aware aggregation (COUNT, SNAPSHOT, RATE, MILESTONE, PERCENTAGE, FINANCIAL)
- Contribution tracking with full audit trail
- Manual override support for administrators
- Trend analysis & unit comparisons
- Year-by-year target tracking (2025–2029)

</td>
<td width="50%">

### 🎯 Strategic Plan Alignment
- Built around **LSPU Strategic Plan 2025–2029**
- 5 KRAs, 22+ strategic initiatives, 100+ KPIs
- Automated mapping of activities to strategic goals
- Gap analysis & opportunity identification
- Quarterly progress monitoring

</td>
</tr>
</table>

<br />

## 🛠️ Tech Stack

| Layer | Technology |
|:---|:---|
| **Framework** | Next.js 16 (App Router) + React 19 |
| **Language** | TypeScript 5 |
| **Styling** | Tailwind CSS 4 + shadcn/ui (Radix primitives) |
| **Database** | PostgreSQL 16 + Prisma 6 ORM |
| **Caching** | Redis 7 (Upstash) |
| **AI / LLM** | OpenAI GPT-4o-mini · Google Gemini · Qwen (OpenRouter) |
| **Vector Search** | Colivara (semantic embeddings) |
| **LangChain** | @langchain/core + @langchain/openai |
| **File Storage** | Azure Blob Storage |
| **Auth** | JWT + bcrypt (custom, edge-compatible) |
| **Charts** | Recharts |
| **Forms** | react-hook-form + Zod validation |
| **PDF/DOCX** | pdf2json · pdfjs-dist · mammoth |
| **Testing** | Jest + ts-jest |
| **Deployment** | Docker + Docker Compose (multi-stage build) |

<br />

## 🚀 Getting Started

### Prerequisites

- **Node.js** 20+
- **PostgreSQL** 16+
- **Redis** 7+
- **npm** or **yarn**

### Quick Setup

```bash
# Clone the repository
git clone https://github.com/Suarenz/LSPU-KMIS.git
cd LSPU-KMIS

# Copy environment variables
cp .env.example .env
# Edit .env with your database credentials and API keys

# Install dependencies and set up database
npm run setup

# Start the development server
npm run dev
```

The app will be running at **http://localhost:4007**

### Docker Deployment

```bash
# Build and start all services (PostgreSQL + Redis + App)
docker compose up -d --build

# The app will be available at http://localhost:4007
```

### Environment Variables

```env
# Required
DATABASE_URL=postgresql://user:password@localhost:5432/lspu_kmis
REDIS_URL=redis://localhost:6379
JWT_SECRET=your-secret-key
NEXT_PUBLIC_API_URL=http://localhost:4007

# AI Services (optional — enables AI features)
COLIVARA_API_KEY=           # Vector search
OPENAI_API_KEY=             # GPT-4o-mini for QPRO analysis
GEMINI_API_KEY=             # Google Gemini generation
QWEN_API_KEY=               # Qwen via OpenRouter

# File Storage
AZURE_STORAGE_CONNECTION_STRING=
AZURE_STORAGE_CONTAINER_NAME=
```

### Available Scripts

| Command | Description |
|:---|:---|
| `npm run dev` | Start dev server (port 4007) |
| `npm run build` | Production build |
| `npm start` | Start production server |
| `npm test` | Run test suite |
| `npm run test:watch` | TDD watch mode |
| `npm run db:migrate` | Create & apply database migrations |
| `npm run db:push` | Sync schema without migrations |
| `npm run db:studio` | Open Prisma Studio (visual DB explorer) |
| `npm run health-check` | Run system health diagnostics |

<br />

## 🏗 Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Client (Browser)                     │
│         Next.js App Router · React 19 · Tailwind         │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│                   API Layer (44 endpoints)                │
│            JWT Auth Middleware · RBAC Guards              │
├──────────┬───────────┬──────────┬───────────────────────┤
│   Auth   │ Documents │  Search  │   QPRO / Analytics    │
│  7 APIs  │  10 APIs  │  5 APIs  │      22+ APIs         │
└────┬─────┴─────┬─────┴────┬─────┴─────┬─────────────────┘
     │           │          │           │
┌────▼───┐ ┌────▼────┐ ┌───▼───┐ ┌────▼──────────────┐
│ JWT +  │ │ Prisma  │ │Colivara│ │ Analysis Engine   │
│ bcrypt │ │  ORM    │ │Vector  │ │ (GPT-4o-mini)     │
└────────┘ └────┬────┘ │Search  │ │ + LangChain       │
                │      └───┬───┘ └────────────────────┘
           ┌────▼────┐ ┌───▼────┐
           │PostgreSQL│ │ Redis  │
           │   16     │ │   7    │
           └─────────┘ └────────┘
```

### Data Model (14 models)

```
User ──┬── Document ──┬── DocumentPermission
       │              ├── DocumentComment (threaded)
       │              ├── DocumentDownload
       │              ├── DocumentView
       │              ├── ColivaraIndex (vectors)
       │              └── QPROAnalysis ──┬── AggregationActivity
       │                                └── KPIContribution
       ├── UnitPermission
       └── Activity (audit log)

Unit ──── KRAggregation ── KPITarget
```

### Role Hierarchy

```
ADMIN (4)    →  Full system access, all units
FACULTY (3)  →  Assigned unit, document upload, QPRO analysis
STUDENT (2)  →  Read-only with explicit permissions
EXTERNAL (1) →  Limited read access
```

<br />

## 📡 API Reference

<details>
<summary><strong>Authentication</strong> (7 endpoints)</summary>

| Method | Endpoint | Description |
|:---|:---|:---|
| POST | `/api/auth/login` | Authenticate user |
| POST | `/api/auth/signup` | Register new user |
| POST | `/api/auth/refresh` | Refresh access token |
| POST | `/api/auth/logout` | Logout & invalidate session |
| GET | `/api/auth/me` | Get current user profile |
| POST | `/api/auth/update-password` | Update password |
| POST | `/api/auth/reset-password` | Reset user password |

</details>

<details>
<summary><strong>Documents</strong> (10 endpoints)</summary>

| Method | Endpoint | Description |
|:---|:---|:---|
| GET | `/api/documents` | List documents (paginated, filtered) |
| POST | `/api/documents` | Upload new document |
| GET | `/api/documents/[id]` | Get document details |
| DELETE | `/api/documents/[id]` | Delete document |
| GET | `/api/documents/[id]/preview` | Preview document |
| GET | `/api/documents/[id]/download` | Download document |
| GET/POST | `/api/documents/[id]/permissions` | Manage permissions |
| GET/POST | `/api/documents/[id]/comments` | Threaded comments |
| POST | `/api/documents/[id]/analyze` | AI analysis |

</details>

<details>
<summary><strong>Search</strong> (5 endpoints)</summary>

| Method | Endpoint | Description |
|:---|:---|:---|
| GET | `/api/search` | Semantic + keyword search |
| POST | `/api/search/chat-query` | Chat with document |
| POST | `/api/search/chat-upload` | Upload file for chat |
| POST | `/api/search/chat-cleanup` | Cleanup temp documents |
| POST | `/api/search/clear-cache` | Clear search cache |

</details>

<details>
<summary><strong>QPRO & Analytics</strong> (15+ endpoints)</summary>

| Method | Endpoint | Description |
|:---|:---|:---|
| POST | `/api/analyze-qpro` | Run QPRO analysis |
| POST | `/api/qpro/upload` | Upload QPRO document |
| GET | `/api/qpro/analyses` | List all analyses |
| POST | `/api/qpro/approve/[id]` | Approve/reject analysis |
| GET | `/api/qpro/trends` | Trend data |
| GET | `/api/aggregations` | KRA/KPI aggregation |
| GET/PUT | `/api/kpi-targets` | KPI target management |
| GET/POST | `/api/kpi-contributions` | Contribution tracking |
| GET | `/api/kpi-progress` | KPI progress data |
| GET | `/api/analytics` | Dashboard analytics |

</details>

<br />

## 📁 Project Structure

```
├── app/                        # Next.js App Router
│   ├── api/                    # 44 API route handlers
│   │   ├── auth/               #   Authentication endpoints
│   │   ├── documents/          #   Document CRUD & permissions
│   │   ├── search/             #   Semantic search & chat
│   │   ├── qpro/               #   QPRO analysis engine
│   │   └── ...                 #   Analytics, units, KPIs
│   ├── dashboard/              # Dashboard page
│   ├── repository/             # Document browser & preview
│   ├── search/                 # AI-powered search page
│   ├── qpro/                   # QPRO analysis pages
│   └── units/                  # Unit management pages
│
├── components/                 # React components
│   ├── qpro/                   #   12 QPRO-specific components
│   └── ui/                     #   shadcn/ui component library
│
├── lib/                        # Core business logic
│   ├── services/               #   29 service modules
│   │   ├── auth-service.ts     #     JWT auth & session
│   │   ├── colivara-service.ts #     Vector search (1400+ LOC)
│   │   ├── analysis-engine-service.ts  # QPRO AI engine
│   │   └── ...
│   ├── middleware/              #   Auth middleware
│   ├── utils/                  #   RBAC, helpers
│   └── data/                   #   Strategic plan data
│
├── prisma/                     # Database schema & migrations
├── __tests__/                  # Jest test suite (7 test files)
├── scripts/                    # Admin & maintenance utilities
├── docs/                       # Technical documentation
│   └── thesis/                 #   Academic framework docs
└── docker-compose.yml          # Full-stack Docker deployment
```

<br />

## 🧪 Testing

```bash
# Run all tests
npm test

# Watch mode for TDD
npm run test:watch
```

Test suite covers:
- QPRO analysis engine logic
- KPI type-aware aggregation
- String conversion utilities
- Service layer integration
- Model capabilities validation

<br />

## 🐳 Docker Deployment

The system ships as a complete Docker Compose stack:

| Service | Image | Port |
|:---|:---|:---|
| **app** | Node 20 Alpine (multi-stage) | 4007 |
| **postgres** | PostgreSQL 16 Alpine | 5432 |
| **redis** | Redis 7 Alpine | 6379 |

```bash
# Start everything
docker compose up -d --build

# View logs
docker compose logs -f app

# Run database migrations
docker compose exec app npx prisma migrate deploy
```

<br />

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

<br />

## 📄 License

This project was developed as an academic thesis project for **Laguna State Polytechnic University**.

<br />

---

<div align="center">

**Built with ❤️ for LSPU**

*Laguna State Polytechnic University — Knowledge Management Information System*

<br />

[![GitHub](https://img.shields.io/badge/GitHub-Suarenz%2FLSPU--KMIS-181717?style=flat-square&logo=github)](https://github.com/Suarenz/LSPU-KMIS)

</div>
