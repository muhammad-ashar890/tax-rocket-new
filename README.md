# TaxRocket

TaxRocket is a guided Pakistan tax-filing workspace built with Next.js. It helps a taxpayer move through profile setup, document review, bank-statement reconciliation, ledger preparation, tax estimation, filing-packet approval, and the FBR connection handoff.

> **Status:** This repository is an MVP/redesign implementation. Some TY2026 tax rules are pilot estimates and must be reviewed before production tax filing. The FBR step currently prepares and gates the handoff to a local trusted desktop agent; it is not a complete FBR submission integration.

## Technology

- Next.js 14.2.x
- React 18
- TypeScript
- Tailwind CSS
- Prisma 5 with PostgreSQL (Docker locally; PostgreSQL on the production VPS)
- NextAuth with Google OAuth
- Gemini AI for document/bank-data extraction and classification
- PDFKit for filing packet PDFs
- XLSX support for structured bank statements

## Main filing flow

1. Sign in with Google
2. Complete taxpayer profile and filing setup
3. Upload and review required tax documents
4. Extract and map document data
5. Import or enter bank statements and transactions
6. Maintain income, expense, asset, and liability ledger entries
7. Resolve wealth reconciliation
8. Calculate a route-specific TY2026 estimate where rules are available
9. Generate and approve a versioned filing packet
10. Start the FBR trusted-agent handoff after all approval gates pass

## Requirements

- Node.js 20.x or newer is recommended
- npm
- A Google OAuth application for login
- A Gemini API key for AI extraction/classification features

## Local setup

Install dependencies:

```bash
npm install
```

Create a `.env` file in the project root. Do not commit this file or share real credentials:

```env
DATABASE_URL="postgresql://taxrocket:taxrocket_dev_password@localhost:5432/taxrocket"
NEXTAUTH_URL="http://localhost:3000"
NEXTAUTH_SECRET="replace-with-a-long-random-secret"
GOOGLE_CLIENT_ID=""
GOOGLE_CLIENT_SECRET=""
GEMINI_API_KEY=""
GEMINI_MODEL="gemini-3.5-flash"
```

Generate the Prisma client:

```bash
npx prisma generate
```

Create/update the local PostgreSQL database using the checked-in migrations. PostgreSQL must be running locally (the recommended setup is the `postgres:16` Docker container):

```bash
npx prisma migrate deploy
```

Use `migrate deploy`, not `migrate dev`. The migration history is already
written and committed; `migrate dev` tries to author a new migration, needs a
shadow database, and fails outright on a non-interactive shell. `deploy`
applies exactly the nine committed migrations and nothing else.

Check migration status:

```bash
npx prisma migrate status
```

Start the development server:

```bash
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000).

## Database deployment plan — completed

Development and production now use PostgreSQL. Local development uses the `postgres:16` Docker container; production will use PostgreSQL on the Hostinger VPS.

The SQLite test database was intentionally not transferred. A fresh PostgreSQL migration history is checked in under `prisma/migrations/`, and the local migration has been verified with:

```bash
npx prisma migrate status
```

At production deployment, set the VPS `DATABASE_URL` to the production PostgreSQL URL and apply the committed schema:

```bash
npx prisma migrate deploy
npx prisma generate
npm run build
npm start
```

The provider is already `postgresql` in `prisma/schema.prisma`, so no SQLite-to-PostgreSQL conversion is needed at deployment time. Do not run `prisma migrate reset` in production.

## Production build verification

```bash
npm run build
npm run start
```

If dependencies were installed with `npm ci --ignore-scripts`, Prisma generation is skipped. Run this before building:

```bash
npx prisma generate
```

## Available scripts

```bash
npm run dev       # Start the development server
npm run build     # Create an optimized production build
npm run start     # Start the production server
npm run lint      # Run the configured lint command
npm run db:generate # Generate the Prisma client
npm run db:migrate  # Run local development migrations
npm run db:deploy   # Apply committed migrations in production
npm run db:status   # Show migration status
```

Database commands used during deployment:

```bash
npx prisma generate       # Generate the Prisma client
npx prisma migrate dev    # Local development migrations
npx prisma migrate deploy # Apply committed migrations in production
```

## Remaining production work

The database migration is complete. Before accepting real tax filings, the following items still require a focused review:

1. Security and ownership audit for every document, packet, and server action.
2. FBR submission integration; the current FBR step is a trusted desktop-agent handoff, not a complete FBR API submission.
3. Persistent document/PDF storage, backups, and secure file serving.
4. Confirmed, versioned FBR tax rules for routes currently returning `NEEDS_RULES`.
5. Money precision review; current monetary fields use `Float` and may need `Decimal`.
6. Automated tests for approval gates, ownership, reconciliation, tax calculation, and packet versioning.
7. Dependency vulnerability review without using `npm audit fix --force`.
8. VPS hardening, HTTPS, OAuth production callback configuration, and backup/restore testing.

## Environment notes

- `NEXTAUTH_URL` must be the actual URL, not a Markdown link.
- `NEXTAUTH_SECRET` should be a strong secret in every non-local environment.
- Google OAuth callback URLs must match the environment URL configured in Google Cloud.
- Gemini extraction/classification requires `GEMINI_API_KEY`.
- Uploaded files and generated packets currently use local filesystem storage under the application directory. A persistent object-storage provider should be used before deploying to a serverless or multi-instance environment.

## Tax-rule scope

The current tax engine includes pilot TY2026 routes for selected salary, pension, rental, and bank-profit cases. It explicitly reports `NEEDS_RULES` where a route is not sufficiently implemented. Credits, surcharge, perquisites, deductions, and several advanced income routes still require confirmed, versioned FBR rules and professional review.

## Security and dependency maintenance

Review dependency advisories regularly:

```bash
npm audit
```

Avoid running `npm audit fix --force` without reviewing the resulting major-version changes. The project uses server actions, authentication, file uploads, Prisma, and spreadsheet parsing, so dependency upgrades should be followed by a full build and workflow verification.

## Project structure

```text
app/                         Next.js routes and server actions
components/                  UI and filing workflow components
lib/tax/                     Tax rules, calculations, eligibility, and filing state
prisma/schema.prisma         Database schema
prisma/migrations/           Checked-in PostgreSQL migrations
```
