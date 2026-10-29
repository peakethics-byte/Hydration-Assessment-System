# WeCanH2O Structured Hydration Assessment System - Milestone 4 (Assessment Core)

Working MVP of the College Athlete module (Module A): secure records, both athlete sign-up ways,
the electronic Structured Hydration Assessment (Q1-Q42), validation, saved drafts, automatic scoring,
HGI and Gap Profile (HGA), Suggested IHS, WeCanH2O review / approval / release, and gold-standard
test evidence. All data is fictional.

## Run it locally

Requirements: Node.js 20. No Docker or database install is needed.

```bash
npm install
npm run db -- reset     # recreates .data/pgdata with fictional demo data
npm run dev             # http://localhost:3100
npm test                # unit + system tests
npm run gold            # gold-standard run -> test-evidence/gold-standard-results.md
```

Stop the dev server before running `npm run db -- reset`. The local database is a single-process file store.

### Fictional test accounts

All seeded accounts use the test-only password `DEV_PASSWORD` in [src/server/seed.ts](src/server/seed.ts).

| Role | Email |
|---|---|
| WeCanH2O Program Administrator (Northbridge) | admin@wecanh2o.test |
| WeCanH2O Program Administrator (Lakeview, the second institution for segregation tests) | admin.lakeview@wecanh2o.test |
| Athletic Trainer / Health Support (Track & Field only) | trainer@northbridge.test |
| Coach (Track & Field) | coach@northbridge.test |
| Athletic Director / Institution Leadership | ad@northbridge.test |
| Technical System Administrator | tech@wecanh2o.test |
| Athletes already registered | jordan.rivers@northbridge.test, riley.hayes@northbridge.test, quinn.parker@lakeview.test |

Still on the team list, for live sign-up demos: Avery Brooks, Casey Morgan and Taylor Reed (Track & Field), and Morgan Ellis (Soccer),
all `@northbridge.test`. Emails the system sends appear in the **Dev mailbox** (`/dev/mailbox`, development only).

## Demo script (about 10 minutes)

1. **Way 1, website sign-up.** At `/signup`, try an email that is not on any list. You are told to contact the coach. Then use `avery.brooks@northbridge.test`, open the link from the Dev mailbox, and set a password, date of birth and mother's maiden name.
2. **Way 2, invitation.** Sign in as the admin. On *Teams & sign-up*, click *Send invitations* for Track & Field. The invitations appear in the Dev mailbox.
3. **Assessment.** Sign in as the athlete and answer Parts 1-8, with answers saved between Parts. Leave Q6 blank and submit. The system says "Assessment Incomplete - HGI Not Calculated" and highlights Q6. Answer Q6 and submit again.
4. **Not visible yet.** *My results* says results are not ready.
5. **Review.** As the admin, open *Review queue*. Records with safety findings are listed first. The detail page shows HGI (internal and display), category scores, HGA findings with rule IDs and inputs, the Hydration Profile, and Suggested recommendations. *Mark Reviewed*, approve or not approve each recommendation (you can choose another available pathway), then *Release to athlete*.
6. **Athlete result.** The athlete sees HGI, band, strengths, priorities and Hydration Action Items. There are no rule IDs, points or weights.
7. **Access.** Sign in as the coach, director or technical admin. None of them can open individual results.
8. **Evidence.** `npm run gold` and `test-evidence/gold-standard-results.md`.

## Architecture (as in Milestone 2)

- **Next.js (App Router), TypeScript.** All scoring, HGA, IHS and access checks run on the server. Pages are server-rendered, and hidden point values never reach the browser.
- **PostgreSQL.** Locally this is [PGlite](https://pglite.dev) (PostgreSQL compiled to WebAssembly, stored in `.data/`). The migrations in [db/migrations](db/migrations) are plain PostgreSQL and run unchanged on Supabase.
- **Row-level security** ([004_security.sql](db/migrations/004_security.sql)). Every user request runs as database role `app_rw` with `app.user_id` set, so the database refuses cross-institution access, coach and leader access to individual rows, and athlete edits after the submission lock. The scoring pipeline runs as the owner only after the server has checked ownership.
- **Release gate in three layers.** These are server checks, RLS (only the institution's Program Administrator can update recommendations), and table constraints (no Approved or released recommendation without an approver and release time). Every step is in the append-only `audit_event` table, which has a trigger that refuses update and delete.
- **Methodology is data.** [src/methodology](src/methodology) holds the content of rule versions A-ASM-1.0, A-SCR-1.0, A-HGA-1.0 and A-REC-1.0. It is stored in `rule_version.content`, and the engines in [src/engine](src/engine) read it at run time. Every assessment stores the four version IDs it was scored with.

| Folder | What |
|---|---|
| `src/methodology/` | Rule-version content: questions (Document #2 wording), point maps, HGA rules, pathway mapping |
| `src/engine/` | Pure scoring, HGA and IHS engines (deterministic, decimal arithmetic, round half up) |
| `src/server/` | Database, sign-in, sign-up, assessment, review, audit, seed |
| `app/` | Screens |
| `db/migrations/` | Schema, Module B schema-only tables, RLS |
| `tests/` | `engine.test.ts`, `change.test.ts` (pure engines, Milestone 3 fixtures and change pairs), `system.test.ts` (Milestone 4 flow, RLS, roles), `reassessment.test.ts` (Milestone 5 workflow, history, search, grants, transfers, duplicates) |
| `scripts/gold-standard.ts` | Document #8 Section 30 execution records from stored backend values |

## Decisions applied and items still DRAFT

| Item | Status in this build |
|---|---|
| Recommendation Library wording | Placeholder text "WeCanH2O" on every entry (`is_placeholder = true`) until WeCanH2O supplies wording |
| HGA trigger values, finding triggers, tie-break, pathway mapping (Milestone 3 Section 6.7) | A-HGA-1.0 and A-REC-1.0 are stored as **Draft / test fixtures**. They are Active in development only and can never be activated in production |
| Closing statement | "Structured Hydration Assessment" used until WeCanH2O confirms (Document #2 says "Hydration Intelligence Assessment") |
| Sign-up | Both ways built: Way 1 website sign-up checked against the team list, and Way 2 invitation |
| Identity matching | `date_of_birth` stored, mother's maiden name stored only as a keyed hash (HMAC-SHA256), plus a combined match hash. Recorded in `personal_data_field` as *Pending WeCanH2O approval* (data-minimization rule). A matching identity goes to a duplicate review and is never merged automatically |
| Draft retention | 14-day window (configurable per institution). A reminder email goes out 3 days before the window closes. The draft then becomes Expired: answers are **kept** (no automatic permanent deletion), and the Program Administrator can reopen it from *Teams & sign-up* |
| Corrections | Admin corrects an answer with a required reason on the review page. The original and corrected values, user and time are kept (`response_correction`), the earlier result is snapshotted (`result_revision`) and superseded, and the record is revalidated and rescored (Correction Required -> Revalidated). It must be reviewed and released again before the athlete sees it |
| Acknowledgment | Versioned acknowledgment records (`ack_record`) with a per-institution "required before the assessment" switch. Placeholder version `ACK-PENDING-1` ("WeCanH2O") is off by default until WeCanH2O supplies the wording |
| Safety routing | A safety finding emails the Program Administrators and the assigned health support (no symptom detail) and lists the record first in the review queue |
| Hosting | Local only for now. Supabase + Vercel to be chosen later. Local sign-in is replaced by Supabase Auth (adds MFA for privileged roles) in staging |
| Individual users (no college) | Built: *Request individual access* -> WeCanH2O Program Administrator approves on **Requests** -> emailed link -> same registration details as athletes (password, date of birth, mother's maiden name). Kept in a separate *Individual Users (WeCanH2O)* group with no team; results go through the same review gate. **Assumed** approver = WeCanH2O Program Administrator; payment not built. Decline email wording is DRAFT |
| Staff accounts | Built on **Users**: the Program Administrator adds a staff member (name, email, role, institution or team, export permission); they set their own password from an emailed link (7 days). *Resend link* and *End access* (history kept). Existing local databases: run `npx tsx scripts/add-individual-tenant.ts` once |
| Reports, exports, aggregation | Milestone 6 |
| Improvement amount, persistent class 4 | DRAFT (Milestone 3 Sections 5.4 and 3.6): 10 percentage points for category findings, one answer level for item findings; repeated C1, C3, C3Q4B, C4, C8 gaps move to priority class 4. Stored in the A-HGA-1.0 test fixture |

## Milestone 5: administration, reassessment and longitudinal analysis

| Contract deliverable | Where |
|---|---|
| Admin search / filtering | **Athletes** (`/athletes`): name, email or Athlete ID; institution, team, latest status, band, safety findings, reassessment state |
| Assessment history, trend | `/athletes/[id]`: KPIs, HGI trend chart, every assessment with the team at the time, intervention history, team history. Athletes: **My history** (`/athlete/history`, released results only) |
| Reassessment workflow | Open a window for a whole team (**Teams & sign-up**) or one athlete. Default target window = next quarter, adjustable. Each reassessment is a new instance; the baseline is never changed. Missed window -> "Reassessment Not Completed / Outcome Unknown" |
| Comparison to prior assessments | Stored `change_analysis`: HGI change from internal values, category and item change, C7 context separately, comparability gate ("Cross-Version Comparison - Review Required" without an approved `rule_version_mapping`) |
| Persistent / improved / worsening / new gaps | `finding_change`: Improved, Resolved, Persistent, Worsened, New (engine: [src/engine/change.ts](src/engine/change.ts)); safety stays first; access and C7 changes marked contextual |
| Role-based behavior | Admin: everything for own institutions. Trainer: assigned athletes. Coach / leadership: nothing, unless WeCanH2O grants explicit, time-limited, logged access on the athlete page. Athlete: own released history |
| Also | Team transfers keep history with the earlier team; duplicate review: "Different people" or "Same person - link records" (nothing deleted; newer sign-in turned off) |

Upgrade an existing local database (keeps your data): stop the app, run `npx tsx scripts/upgrade-m5.ts`, start the app.
`npm run db -- reset` also adds demo history: **Casey Morgan** (baseline 90 days ago, reassessment now, improvement) and **Taylor Reed** (missed window, Outcome Unknown).

## Environment variables

| Name | Purpose |
|---|---|
| `DB_DIR` | Local database folder (default `.data/pgdata`) |
| `APP_BASE_URL` | Base URL used in emailed links (default `http://localhost:3100`) |
| `IDENTITY_PEPPER` | Secret key for the identity hashes. **Required in production.** Development uses a fixed non-secret value |
