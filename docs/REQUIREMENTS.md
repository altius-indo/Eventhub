# EventHub — Product Requirements (v1)

> Status: **Draft for review** · Captured: 2026-11-01 via interactive requirements session
> Owner: Product owner (subhajyoti) · Next step: review → sign-off → architecture & scaffold

---

## 1. Product Summary

**EventHub** is a web application that serves as the single planning system for **large, multi-day Indian weddings** (200–1,000 guests, 10–40 vendors). It brings together itinerary planning, guest management and logistics, vendor management, budgets, invoices and payment tracking, and messaging. Families, their planners, vendors and guests each get the right view.

### 1.1 Decisions from the session

| Topic | Decision |
|---|---|
| Primary customer | Individuals / families (personal use) |
| Event type (v1) | Multi-day weddings (mehendi, haldi, sangeet, wedding, reception, …) |
| Scale per event | 200–1,000 guests, 10–40 vendors |
| Logged-in users | Planners/staff, Hosts (family), Vendors, Guests |
| Guest access | Magic link per household, no account or password |
| Payments | **Tracking only**; money moves outside the app |
| Region | India: INR (lakh/crore formatting), GST on invoices |
| Access control | Role-based plus **side scoping** (bride/groom) and function scoping |
| Tenancy | One account can own/collaborate on **multiple events**; events can be copied as templates |
| Monetisation | Free / personal use; no billing in v1 |
| Tech stack | Next.js (TypeScript) + PostgreSQL + Prisma + Tailwind |
| Release scope | **All modules in Phase 1** (sequenced as internal milestones; see §9) |

---

## 2. Users & Roles

| Role | Who | Access summary |
|---|---|---|
| **Owner** | Event creator (usually the couple or a parent) | Full access, manages members and roles, final approvals |
| **Host** | Close family decision-makers | View everything, approve budgets/spend, edit within allowed modules |
| **Planner** | Hired planner or staff | Full operational edit (guests, itinerary, vendors, budget); cannot delete the event or change owners |
| **Side Coordinator** | Bride-side / groom-side family coordinators | Manage guests, RSVPs, travel and rooms **only for their side**; read the itinerary |
| **Function Coordinator** | Person in charge of a function (e.g. sangeet) | Edit run sheet and tasks for **assigned functions** |
| **Vendor** | Service provider (caterer, decorator, …) | Vendor portal: own brief, relevant run-sheet items, own quotes, contracts, invoices and payment status, chat with the team |
| **Guest** | Invited household (magic link) | Own household's invites, RSVP, personalised itinerary, travel/room details, broadcasts |

### 2.1 Permission matrix (summary)

| Module | Owner | Host | Planner | Side Coord. | Func. Coord. | Vendor | Guest |
|---|---|---|---|---|---|---|---|
| Event settings & members | RW | R | R | – | – | – | – |
| Guests / households | RW | RW | RW | RW (own side) | R (own functions) | – | Own household |
| RSVP | RW | RW | RW | RW (own side) | R | Headcount only* | Own |
| Travel & rooms | RW | RW | RW | RW (own side) | – | Transport/hotel vendor: assigned only | Own |
| Seating & check-in | RW | RW | RW | RW (own side) | RW (own functions) | – | Own table |
| Itinerary / functions | RW | RW | RW | R | RW (own functions) | Assigned functions | Invited functions |
| Run sheet | RW | R | RW | R | RW (own functions) | Own items | – |
| Tasks | RW | RW | RW | Own/assigned | Own functions | Own tasks | – |
| Vendors & quotes | RW | RW | RW | R | R | Own | – |
| Contracts & documents | RW | RW | RW | – | – | Own | – |
| Budget | RW | RW (approve) | RW | R (own side payer)* | – | – | – |
| Invoices & payments | RW | RW (approve) | RW | R (own side payer)* | – | Own (upload, view status) | – |
| Messaging / broadcasts | RW | RW | RW | Own side | Own functions | Own threads | Receive / reply |
| Reports | RW | R | R | Own side | Own functions | – | – |

\* Open question; see §11.

---

## 3. Functional Requirements

IDs: `MOD-NN`. Priority: **M** = must (v1), **S** = should (v1 if feasible), **C** = could (later).

### 3.1 Accounts, Events & Tenancy (`EVT`)
- **EVT-01 (M)** Sign-up/login for staff roles with email OTP or magic link (phone OTP optional, see §11).
- **EVT-02 (M)** Create an event: name, couple names, dates, primary city, cover image, default currency INR.
- **EVT-03 (M)** A user can belong to multiple events with a different role in each; event switcher in the header.
- **EVT-04 (M)** Invite members by email/phone with role and optional side/function scope; revoke access.
- **EVT-05 (S)** Duplicate an event as a template: functions, task checklist, budget categories, vendor categories, but no guests.
- **EVT-06 (M)** Audit log of key changes (who changed what, when) for budget, payments, RSVP and permissions.

### 3.2 Functions & Itinerary (`ITN`)
- **ITN-01 (M)** Define **functions** (sub-events): name, date, start/end time, venue (name, address, map link), dress code/theme, description, cover image.
- **ITN-02 (M)** Master schedule view: day-by-day timeline of all functions.
- **ITN-03 (M)** **Run sheet** per function: time-slotted items with title, duration, owner (member or vendor), location, notes and status (pending/in progress/done). Live "day-of" mode shows what's next.
- **ITN-04 (M)** **Personalised guest itinerary**: each household sees only the functions it's invited to, plus its own travel, pickup and room details.
- **ITN-05 (M)** Planning **task checklist**: tasks with due date, assignee, function link, priority, status, comments and reminders. Default wedding checklist template.
- **ITN-06 (S)** Calendar view and ICS export of functions and tasks.
- **ITN-07 (M)** Export run sheet / itinerary to PDF.

### 3.3 Guest Management (`GST`)
- **GST-01 (M)** **Households**: a household has a head and members (name, relation, age group adult/child/infant, phone, email, dietary preference, accessibility notes).
- **GST-02 (M)** Attributes: **side** (bride / groom / both-mutual), free-form **tags** (VIP, elders, kids, college friends, …).
- **GST-03 (M)** **Per-function invitations** at household or member level.
- **GST-04 (M)** Bulk **import from Excel/CSV** with column mapping, duplicate detection and validation report; export to Excel.
- **GST-05 (M)** Search, filter and save views (by side, tag, function, RSVP status, travel status).
- **GST-06 (M)** Guest **magic link** per household, shareable over WhatsApp/SMS/email; regenerate or revoke.

### 3.4 RSVP (`RSV`)
- **RSV-01 (M)** Guests RSVP **per function, per member**: attending / not attending / maybe.
- **RSV-02 (M)** Capture +1s (if allowed), kids count, meal preference (veg / non-veg / Jain / vegan / custom) and allergies.
- **RSV-03 (M)** RSVP deadline; automated reminders to non-responders (via messaging channels).
- **RSV-04 (M)** Planners and coordinators can record RSVPs on behalf of guests (phone calls with elders).
- **RSV-05 (M)** Live headcount per function, broken down by side, meal type and adults/kids; exportable for caterers.

### 3.5 Travel & Accommodation (`TRV`)
- **TRV-01 (M)** Per member: arrival and departure (mode, flight/train no., date-time, terminal/station), self-arranged vs needs pickup.
- **TRV-02 (M)** Guests can submit and update their travel details via the magic link.
- **TRV-03 (M)** **Transfers**: create pickup/drop runs (vehicle, driver, capacity, time) and assign guests; manifest per vehicle; arrivals board by time window.
- **TRV-04 (M)** **Hotels & room blocks**: hotels, room types, blocked count, rate, check-in/check-out.
- **TRV-05 (M)** **Room allocation**: assign members to rooms, with occupancy and conflict warnings; rooming list export for hotels.
- **TRV-06 (S)** Inter-venue shuttle schedules per function.

### 3.6 Seating & Check-in (`SEAT`)
- **SEAT-01 (M)** Per-function table plan: tables (name/number, capacity), drag-and-drop guest assignment, unassigned list.
- **SEAT-02 (M)** Seating constraints: keep household together (default), side grouping, warnings over capacity.
- **SEAT-03 (M)** **Check-in**: QR code per household/member (in magic link), scanner on a mobile browser, manual search fallback; live arrived vs expected count.
- **SEAT-04 (S)** Offline-tolerant check-in (queue scans and sync later).

### 3.7 Vendors (`VND`)
- **VND-01 (M)** Vendor directory: category (caterer, decor, photography, videography, DJ/music, makeup, mehendi artist, venue, transport, hotel, florist, priest/pandit, lighting, security, …), contacts, GSTIN, PAN, bank details (masked), rating, notes.
- **VND-02 (M)** Assign vendors to functions with a **brief/scope of work**.
- **VND-03 (M)** **Quotes**: request and record multiple quotes per need, with line items, taxes and validity; **side-by-side comparison**; shortlist → book (converts to a budget commitment).
- **VND-04 (M)** **Contracts & documents**: upload (PDF/images), key terms (amount, cancellation policy, deliverables, deadlines), with reminders on key dates.
- **VND-05 (M)** **Vendor portal**: vendor logs in (email/phone OTP) to see assigned functions, brief and their run-sheet items; upload quotes and invoices; view payment schedule and status; chat with the team.
- **VND-06 (S)** Vendor performance rating after the event.

### 3.8 Budget (`BGT`)
- **BGT-01 (M)** Budget structure: **category → line items**, each with planned, committed (booked/contracted) and actual (invoiced/paid) amounts.
- **BGT-02 (M)** Allocate line items to **functions** (one or many, with split %).
- **BGT-03 (M)** Allocate to **payer/side**: bride's family / groom's family / shared (split % or fixed amounts).
- **BGT-04 (M)** **Approval workflow**: spend above a configurable threshold, or any increase above the planned amount, needs Host/Owner approval; approve/reject with comment.
- **BGT-05 (M)** Budget dashboard: total vs planned, by category, function and payer; variance highlights.
- **BGT-06 (M)** INR formatting with Indian grouping (₹12,34,567) and lakh/crore short form.

### 3.9 Invoices & Payment Tracking (`PAY`)
- **PAY-01 (M)** Invoices: vendor, number, date, line items, **GST** (CGST/SGST or IGST, rate, GSTIN), total, attachment; linked to a booking/budget line.
- **PAY-02 (M)** **Payment schedule** per booking: advance / milestones / final, each with amount or %, due date and payer.
- **PAY-03 (M)** Record payments: date, amount, mode (UPI, bank transfer, cheque, cash, card), reference no., payer, receipt upload.
- **PAY-04 (M)** Status per milestone and invoice: **upcoming / due / overdue / partially paid / paid**; vendor sees the same status in the portal.
- **PAY-05 (M)** Reminders for upcoming and overdue payments to the payer side.
- **PAY-06 (M)** Payables report: what's due this week/month, by payer and vendor; export to Excel/PDF.
- **PAY-07 (C)** In-app payment collection or payout via gateway (Razorpay); **out of scope for v1**.

### 3.10 Messaging & Notifications (`MSG`)
- **MSG-01 (M)** **In-app chat**: a team channel, a thread per vendor, a thread per function; attachments, @mentions, read state.
- **MSG-02 (M)** **Guest broadcasts**: compose once, target a segment (side, tag, function invitees, RSVP status, travel group, hotel), choose channels; delivery stats.
- **MSG-03 (M)** **WhatsApp Business API** integration (via a BSP such as Gupshup, Interakt or Twilio): invites with magic link, RSVP reminders, travel/pickup updates, day-of announcements using pre-approved templates. Opt-out handling.
- **MSG-04 (M)** **Email** (transactional and broadcast) and **SMS** (DLT-registered templates for India).
- **MSG-05 (M)** In-app notification centre plus user notification preferences.
- **MSG-06 (S)** Guest replies on WhatsApp land in a shared inbox in the app.

### 3.11 Dashboards & Reports (`RPT`)
- **RPT-01 (M)** Event home dashboard: countdown, RSVP funnel, headcount per function, tasks due/overdue, budget burn, payments due, arrivals today.
- **RPT-02 (M)** Exports: guest list, headcount per function, rooming list, transfer manifests, seating chart, run sheet, budget, payables (Excel and PDF).

### 3.12 Localisation (`L10N`)
- **L10N-01 (M)** UI i18n framework from day one; **English + Hindi** in v1, structured to add regional languages (Bengali, Marathi, Tamil, Telugu, Gujarati, …).
- **L10N-02 (M)** Guest-facing pages and message templates available per language; guest language preference per household.
- **L10N-03 (M)** Timezone: event timezone (default Asia/Kolkata), shown consistently.

---

## 4. Non-Functional Requirements

| Area | Requirement |
|---|---|
| **Responsiveness / PWA** | Mobile-first for guest, vendor and day-of screens. Installable PWA. Cached run sheet, guest lookup and check-in work through brief connectivity loss at venues. |
| **Performance** | Lists of 1,000 guests filter and search in under 300 ms (p95); pages interactive in under 2.5 s on 4G. |
| **Scale** | ~1,000 guests, 40 vendors and ~50 staff users per event; around 100 concurrent events at launch. |
| **Security** | HTTPS everywhere; magic links are long, unguessable, revocable and rate-limited; role and scope checks enforced server-side; bank/ID data encrypted at rest and masked in the UI. |
| **Privacy** | Personal data (phones, travel, IDs) visible only to roles that need it. Data export and deletion per event. Aligned with India's DPDP Act 2023 (consent for messaging, purpose limitation). |
| **Reliability** | Daily backups with point-in-time recovery; 99.5% uptime target; message sending through a retryable job queue. |
| **Auditability** | Immutable audit log for money, RSVP and permission changes. |
| **Accessibility** | WCAG 2.1 AA for guest-facing pages; large tap targets and readable fonts for elderly guests. |
| **Files** | Uploads (contracts, invoices, receipts) up to 20 MB, stored in object storage with signed URLs. |

---

## 5. Core Data Model (conceptual)

```
User ─< EventMember >─ Event
                 └─ role, side_scope, function_scope[]

Event ─< Function ─< RunSheetItem (owner: Member|Vendor)
      ─< Task (assignee, function?)
      ─< Household ─< Guest (side, tags[], age_group, diet)
                         ├─< Invitation (function) ─ RSVP (status, meal, plus_ones)
                         ├─ TravelLeg (arrival/departure)  >─ TransferRun
                         ├─ RoomAssignment >─ Room >─ RoomBlock >─ Hotel
                         └─ SeatAssignment >─ Table >─ Function
      ─< Vendor (category, GSTIN, bank*)
            ├─< VendorAssignment (function, brief)
            ├─< Quote ─< QuoteLineItem
            ├─< Contract / Document
            └─< Booking ─< PaymentMilestone ─< Payment
                       └─< Invoice ─< InvoiceLineItem (GST)
      ─< BudgetCategory ─< BudgetLine (planned, committed, actual)
                              ├─ allocations: Function %, Payer %
                              └─< ApprovalRequest
      ─< Thread (team|vendor|function) ─< Message
      ─< Broadcast (segment, channels) ─< Delivery (status per recipient)
      ─< AuditLog
```

---

## 6. Key User Journeys

1. **Set up the wedding**: Owner creates the event → adds functions → invites the planner and side coordinators → applies the checklist and budget template.
2. **Build the guest list**: Coordinators import Excel → map columns → fix duplicates → tag side and groups → set per-function invites.
3. **Invite & RSVP**: Send WhatsApp invites with magic links → guests RSVP per function and member, enter travel → reminders go to non-responders.
4. **Logistics**: Planner reviews the arrivals board → creates pickup runs → allocates rooms → exports rooming lists to hotels.
5. **Vendors & money**: Request quotes → compare → book (creates budget commitment and payment schedule) → vendor uploads invoice in the portal → host approves → payer records payment → vendor sees "Paid".
6. **Day-of**: Coordinators open the run sheet in live mode on their phones → check guests in by QR → broadcast "Baraat starts in 15 min" to groom-side guests.

---

## 7. Technical Direction

- **Frontend/Backend**: Next.js (App Router, TypeScript), React Server Components plus server actions/route handlers; Tailwind CSS with an accessible component library (e.g. shadcn/ui).
- **Database**: PostgreSQL via Prisma. Every event-scoped table carries `event_id`; authorisation is centralised in a policy layer (role + side/function scope).
- **Auth**: Auth.js (NextAuth) with email magic link/OTP for members and vendors; signed, revocable tokens for guest household links.
- **Background jobs**: Queue (e.g. BullMQ/Redis or pg-boss) for messaging, reminders, imports and exports.
- **Integrations**: WhatsApp BSP, email provider (Resend/SES), SMS provider with DLT templates, object storage (S3-compatible).
- **Realtime**: Chat and live check-in counts via WebSockets/SSE (e.g. Pusher/Ably or self-hosted).
- **i18n**: `next-intl`; message templates stored per locale.
- **PWA**: Service worker caching for run sheet, guest lookup and check-in queue.
- **Exports**: Excel (`exceljs`), PDF (server-side HTML→PDF).
- **Hosting**: Vercel or a container platform plus managed Postgres (an India region is preferred for data residency).

---

## 8. Out of Scope (v1)

- Processing payments, payouts or escrow (tracking only).
- Billing/subscriptions (free for personal use).
- Non-wedding event types (the conference/festival data model can come later).
- Public vendor marketplace / discovery.
- Native iOS/Android apps (the PWA covers mobile).
- Multi-currency (INR only).

---

## 9. Delivery Plan

All modules ship in **Phase 1**, built in this order so each milestone is usable and testable:

| Milestone | Scope |
|---|---|
| **M1 Foundation** | Auth, events, members, roles and scoping policy layer, audit log, i18n scaffold, PWA shell, dashboard skeleton |
| **M2 Guests & Itinerary** | Households/guests, import/export, tags/sides, functions, master schedule, per-function invites, tasks |
| **M3 Guest Experience** | Magic links, RSVP, personalised itinerary, guest travel submission, Hindi guest pages |
| **M4 Logistics** | Travel, transfers, hotels/room blocks, room allocation, seating plans, QR check-in |
| **M5 Vendors & Money** | Vendor directory, quotes and comparison, contracts, budget (categories/functions/payer), approvals, invoices with GST, payment schedules/status |
| **M6 Communication** | In-app chat, vendor portal, broadcasts, email/SMS/WhatsApp integration, reminders |
| **M7 Hardening** | Run sheet live mode, offline check-in, reports/exports, performance, security review, UAT on a real wedding dataset |

**Lead-time risk:** WhatsApp Business API approval (Meta business verification, template approval) and SMS **DLT registration** take days to weeks. Start these during M1.

---

## 10. Assumptions

- Families use one or more planners or tech-comfortable coordinators; elders mainly use guest magic links or are handled by coordinators.
- One event typically has 5–8 functions over 2–4 days, sometimes across multiple venues/cities.
- Vendors invoice in INR with GST; some small vendors have no GSTIN (GST fields optional).
- Payments happen outside the app (UPI/bank/cash); the app records them as the system of record.

---

## 11. Open Questions (to resolve before/during M1)

1. **Login method for staff and vendors**: email OTP only, or also phone OTP (SMS/WhatsApp)? Phone is more natural in India but adds SMS cost.
2. **Vendor visibility of headcount**: should caterers see live RSVP headcount for their functions automatically?
3. **Side coordinators and money**: can side coordinators see their side's budget and payables, or should finance stay Owner/Host/Planner only?
4. **Approval threshold**: one global threshold, or per category/payer? Who approves when both families share a cost?
5. **Guest ID collection**: do hotels need guest ID proofs (Aadhaar/passport) collected via the app? This has significant privacy implications.
6. **Gifts / shagun tracking and thank-you notes**: in scope?
7. **Wedding website**: is a public, shareable wedding microsite (story, photos, venue info) wanted in addition to private magic links?
8. **Photo sharing / gallery** after the event: in scope?
9. **Data retention**: how long are guest and personal data kept after the event ends?
10. **Branding**: product name "EventHub" final? Any visual identity or theme preferences (e.g. per-event colour themes for invites)?
11. **Hosting/budget constraints** for third-party services (WhatsApp per-message cost, SMS, email)?
