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
| Staff & vendor login | **Passwordless OTP** to phone (SMS / WhatsApp) **or** email; no passwords |
| Guest access | Magic link per household, no account or password |
| Payments | **Tracking only**; money moves outside the app |
| Photo gallery | **Post-event gallery** per function: photographers, family and guests upload; guests see photos from functions they were invited to |
| Wedding website | **Public wedding microsite** per event; shows only what the family marks public, with a personalised view when opened via a guest's magic link |
| Data retention | Event data kept for **1 year after the event's last function**, then permanently deleted (after export reminders) |
| Gifts | **Shagun / gift tracking and thank-you notes** included; gift data is private to the receiving family |
| Spend approvals | **Per-category thresholds**; a cost is approved by the family/families paying it, so **shared costs need both families** |
| Region | India: INR (lakh/crore formatting), GST on invoices |
| Access control | Role-based plus **side scoping** (bride/groom) and function scoping |
| Tenancy | One account can own/collaborate on **multiple events**; events can be copied as templates |
| Monetisation | Free / personal use; no billing in v1 |
| Tech stack | Next.js (TypeScript) + PostgreSQL + Prisma + Tailwind |
| Planning structure | **Event → Function → Service → Requirement**; vendors are booked to meet requirements (one or more vendors per requirement, with split). Coordinators **propose** requirements; the **Planner approves** |
| Quotes | Vendors quote **per service** or as a **combined quote across functions** (e.g. Catering for Mehendi + Sangeet + Reception); every line maps to a specific service's requirement |
| Release scope | **All modules in Phase 1** (sequenced as internal milestones; see §9) |

---

## 2. Users & Roles

| Role | Who | Access summary |
|---|---|---|
| **Owner** | Event creator (usually the couple or a parent) | Full access, manages members and roles; approves spend for their family side (or as a fallback) |
| **Host** | Close family decision-makers, each tagged to the **bride's or groom's family** | View everything, approve spend **on behalf of their family**, edit within allowed modules |
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
| RSVP | RW | RW | RW | RW (own side) | R | Caterers: live aggregate headcount for booked functions (RSV-06) | Own |
| Travel & rooms | RW | RW | RW | RW (own side) | – | Transport/hotel vendor: assigned only | Own |
| Seating & check-in | RW | RW | RW | RW (own side) | RW (own functions) | – | Own table |
| Itinerary / functions | RW | RW | RW | R | RW (own functions) | Assigned functions | Invited functions |
| Run sheet | RW | R | RW | R | RW (own functions) | Own items | – |
| Tasks | RW | RW | RW | Own/assigned | Own functions | Own tasks | – |
| Services & requirements | RW | RW | RW + approve | R + propose | R + propose (own functions) | Services they're invited to quote for or booked on | – |
| Vendors & quotes | RW | RW | RW | R | R (own functions) | Own | – |
| Contracts & documents | RW | RW | RW | – | – | Own | – |
| Budget | RW | RW (approve) | RW | R (own side's share, BGT-07) | – | – | – |
| Invoices & payments | RW | RW (approve) | RW | R (own side's share, BGT-07) | – | Own (upload, view status) | – |
| Messaging / broadcasts | RW | RW | RW | Own side | Own functions | Own threads | Receive / reply |
| Reports | RW | R | R | Own side | Own functions | – | – |
| Gifts / shagun & thank-yous | RW | RW (own family side) | – (grantable) | Record + view own entries | – | – | – |
| Wedding website | RW + publish | RW + publish | RW (publish needs Owner/Host) | – | – | – | View (+ personalised view via magic link) |
| Photo gallery | RW + moderate | RW + moderate | RW + moderate | Upload + view | Upload + view (own functions) | Photographers/videographers: upload to booked functions | View invited functions; upload (if enabled) |



---

## 3. Functional Requirements

IDs: `MOD-NN`. Priority: **M** = must (v1), **S** = should (v1 if feasible), **C** = could (later).

### 3.1 Accounts, Events & Tenancy (`EVT`)
- **EVT-01 (M)** **Passwordless login** for all staff roles and vendors, with **no passwords anywhere**:
  - **Identifier**: the user enters a **mobile number** (Indian +91 by default, international allowed) **or an email address** and receives a one-time code.
  - **Delivery**: phone OTP goes by **SMS** (DLT-registered template), with **WhatsApp** (authentication template) as an alternative or fallback channel. Email OTP goes by transactional email.
  - **Code rules**: 6 digits, valid 5 minutes, at most 5 attempts per code. Resend cooldown of 30 s, plus rate limits per identifier, IP and device.
  - **Phone convenience**: Android SMS auto-read (WebOTP API) where supported.
- **EVT-01a (M)** **One account, multiple identifiers**: a user can link both a phone number and an email, each verified by OTP, and log in with either. Duplicate accounts are merged when an invite's identifier matches an existing user.
- **EVT-01b (M)** **Invitations by phone or email**: members and vendors are invited by phone number or email. The first login with that identifier, verified by OTP, accepts the invite.
- **EVT-01c (M)** **Sessions**: on a trusted device, a session lasts 30 days with a sliding expiry. Users can view and revoke active sessions and log out everywhere. Owners can revoke a member's sessions when removing them.
- **EVT-01d (S)** **Step-up re-verification**: a fresh OTP is required for sensitive actions, such as changing the owner, viewing or editing vendor bank details, deleting an event or bulk-exporting guest data.
- **EVT-02 (M)** Create an event: name, couple names, dates, primary city, cover image, default currency INR.
- **EVT-03 (M)** A user can belong to multiple events with a different role in each; event switcher in the header.
- **EVT-04 (M)** Invite members by email/phone with role and optional side/function scope; revoke access. Owners and Hosts carry a **family side** (bride / groom), which decides whose approval they give (BGT-04).
- **EVT-05 (S)** Duplicate an event as a template: functions, task checklist, budget categories, vendor categories, but no guests.
- **EVT-06 (M)** Audit log of key changes (who changed what, when) for budget, payments, RSVP and permissions.
- **EVT-07 (M)** **Data retention: 1 year after the event.**
  - **When**: the retention clock starts at the end of the event's **last function**. The event page shows a "data will be deleted on <date>" banner from then on.
  - **What is deleted**: on the deletion date, all event data is **permanently deleted**: guests and households, RSVPs, travel and rooms, seating, messages and chat, broadcasts, services/requirements, quotes, contracts, invoices, payments, budget, gifts and thank-yous, the wedding website, the photo gallery (all media and face data), uploaded files and the event's audit log. Guest magic links, website URLs and vendor portal access to the event stop working.
  - **What is kept**: only **anonymised aggregate counts** (e.g. number of guests, functions), for product metrics. **Templates** saved from the event (EVT-05), which contain no personal data, also stay. User accounts (login identities) remain, and their membership in the deleted event is removed.
- **EVT-08 (M)** **Before deletion: reminders and export.**
  - **Reminders**: Owner and Hosts are notified **60, 30 and 7 days** before deletion (in-app plus email/WhatsApp).
  - **Full archive**: a one-click download of the whole event. It includes Excel files (guests, RSVPs, budget, payments, vendors, gifts and thank-yous), PDFs (run sheets, invoices, contracts) and a ZIP of gallery originals (split into parts if large).
  - **Vendors**: vendors are reminded to download their own invoices and payment records for the event.
- **EVT-09 (M)** **Earlier deletion**:
  - **Whole event**: the Owner can delete the event at any time (with step-up OTP, EVT-01d, and a 7-day undo window).
  - **One guest**: an individual guest can ask for their data to be deleted at any time (DPDP right to erasure). Coordinators process the request from the guest's record and it is logged.
  - **Backups**: deleted data is purged from backups within **35 days** (the backup rotation window).

### 3.2 Functions & Itinerary (`ITN`)
- **ITN-01 (M)** Define **functions** (sub-events): name, date, start/end time, venue (name, address, map link), dress code/theme, description, cover image.
- **ITN-02 (M)** Master schedule view: day-by-day timeline of all functions.
- **ITN-03 (M)** **Run sheet** per function: time-slotted items with title, duration, owner (member or vendor), location, notes and status (pending/in progress/done). Live "day-of" mode shows what's next.
- **ITN-04 (M)** **Personalised guest itinerary**: each household sees only the functions it's invited to, plus its own travel, pickup and room details.
- **ITN-05 (M)** Planning **task checklist**: tasks with due date, assignee, function link, priority, status, comments and reminders. Default wedding checklist template.
- **ITN-06 (S)** Calendar view and ICS export of functions and tasks.
- **ITN-07 (M)** Export run sheet / itinerary to PDF.

### 3.3 Guest Management (`GST`)
- **GST-01 (M)** **Households**: a household has a head and members (name, relation, age group adult/child/infant, phone, email, dietary preference, accessibility notes). Optional **postal address** per household (for printed invites and thank-you cards).
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
- **RSV-06 (M)** **Caterer live headcount**: vendors booked on a **Catering** service automatically see the live headcount for **the functions they're booked for**, and only those, in the vendor portal.
  - **What they see**: expected attendees (confirmed + maybe, shown separately), adults/kids/infants, meal preference counts (veg / non-veg / Jain / vegan / custom), allergy counts, and pending RSVPs still outstanding.
  - **Aggregate only**: no guest names, phone numbers or other personal data.
  - **Split bookings**: when a requirement is split between caterers (e.g. two caterers for one function), each sees the function headcount plus their own contracted share.
  - **Change alerts**: the caterer and the service owner are notified when headcount moves by more than a configurable threshold (default ±5% or ±20 guests) since the caterer last viewed or acknowledged it. The caterer can **acknowledge** the latest count.
  - **Export**: the caterer can download the headcount summary (PDF/Excel).
- **RSV-07 (S)** **Final headcount lock**: per catering booking, the planner sets a "final guarantee" date (e.g. 72 h before the function). After that date:
  - the headcount shown to the caterer is frozen;
  - later RSVP changes are shown to the planner as a delta;
  - the planner can release an updated final count manually.

### 3.5 Travel & Accommodation (`TRV`)
- **TRV-01 (M)** Per member: arrival and departure (mode, flight/train no., date-time, terminal/station), self-arranged vs needs pickup.
- **TRV-02 (M)** Guests can submit and update their travel details via the magic link.
- **TRV-03 (M)** **Transfers**: create pickup/drop runs (vehicle, driver, capacity, time) and assign guests; manifest per vehicle; arrivals board by time window.
- **TRV-04 (M)** **Hotels & room blocks**: hotels, room types, blocked count, rate, check-in/check-out.
- **TRV-05 (M)** **Room allocation**: assign members to rooms, with occupancy and conflict warnings; rooming list export for hotels (names, room, dates and contact phone only; no ID documents or ID numbers, see §8).
- **TRV-06 (S)** Inter-venue shuttle schedules per function.

### 3.6 Seating & Check-in (`SEAT`)
- **SEAT-01 (M)** Per-function table plan: tables (name/number, capacity), drag-and-drop guest assignment, unassigned list.
- **SEAT-02 (M)** Seating constraints: keep household together (default), side grouping, warnings over capacity.
- **SEAT-03 (M)** **Check-in**: QR code per household/member (in magic link), scanner on a mobile browser, manual search fallback; live arrived vs expected count.
- **SEAT-04 (S)** Offline-tolerant check-in (queue scans and sync later).

### 3.7 Services & Requirements (`SVC`)

The planning backbone: **every function has services, every service has requirements, and vendors are booked to meet requirements.**

```
Event
 └─ Function (e.g. Sangeet)
     └─ Service (e.g. Catering)
         └─ Requirement (e.g. "Dinner buffet, 400 pax, veg + Jain counter")
             └─ Fulfilment ← Vendor (one or more, each covering a share)
```

- **SVC-01 (M)** **Service catalogue** per event: service types (Catering, Decor, Photography, Videography, DJ/Music, Makeup, Mehendi artist, Venue, Transport, Hotel, Florist, Pandit, Lighting, Security, …). Planners can add custom types. Each type can carry **requirement templates** (e.g. Catering → meal, counters, staff, crockery).
- **SVC-02 (M)** Add **services to each function**, e.g. Sangeet → Catering, Decor, DJ, Photography. A function shows all its services and their fulfilment status at a glance.
- **SVC-03 (M)** Each service has an **owner** (planner or function coordinator), notes/brief, reference images, and a status rolled up from its requirements.
- **SVC-04 (M)** **Requirements** under a service, each with:
  - **Quantity, unit and specs**: e.g. 400 plates, 20 cars, 2 cameras, 4K; free-text specs and attachments (menu, mood board).
  - **Date/time and venue**: default from the function, overridable (e.g. decor set-up the evening before).
  - **Budget estimate**: planned cost, which feeds the budget (§3.9).
  - **Priority**: must-have / nice-to-have.
  - **Status**: proposed → open → quoting → partially booked → booked → delivered (or cancelled / rejected).
- **SVC-05 (S)** **Quantity-linked requirements**: a requirement's quantity can be linked to live data, such as catering pax = RSVP headcount for the function + buffer %, or cars = guests needing pickup / car capacity. Changes flag the requirement and the booked vendor for review.
- **SVC-06 (M)** **Fulfilment**: a requirement is met by **one or more vendors**, each covering a share (quantity or %) at an agreed amount. The requirement shows coverage, e.g. "20 / 30 cars covered", and stays *partially booked* until fully covered.
- **SVC-07 (M)** **Gap view**: across the event, list requirements not fully covered, sorted by function date and priority, with days remaining.
- **SVC-08 (S)** Mark requirements **delivered** after the function (by the service owner, optionally confirmed by the vendor). This can release the final payment milestone.
- **SVC-09 (S)** Copy services and requirements from one function to another, or from an event template.
- **SVC-10 (M)** **Proposal & approval workflow**:
  - **Who proposes**: Side Coordinators (any function, tagged with their side) and Function Coordinators (their own functions) can **propose** new requirements, new services, or changes to existing requirements (quantity, specs, timing, estimate).
  - **Who approves**: the **Planner** reviews proposals and can approve, reject (with reason) or request changes. The Owner can also approve, as a fallback when no Planner is assigned.
  - **Before approval**: proposed items are visible but excluded from budget *planned* totals (shown separately as "pending proposals" with their estimated impact). They can't be sent for quotes or booked.
  - **Changes to booked requirements**: changes to a requirement that's already booked also need approval. Once approved, the booked vendor is notified, and any cost change goes through budget approval (BGT-04).
  - **Notifications and audit**: proposers are notified of decisions. Planners have an approval queue with a badge count, filterable by function and side. Every proposal, decision and comment is kept in the audit log.

### 3.8 Vendors & Quotes (`VND`)
- **VND-01 (M)** Vendor directory: service types offered (one vendor can offer several), contacts, GSTIN, PAN, bank details (masked), rating, notes.
- **VND-02 (M)** **Request quotes**: invite one or more vendors to quote for **one service or a group of services**. Groups are typically the same service type across several functions (e.g. Catering for Mehendi, Sangeet and Reception) but may mix types (e.g. Decor + Florals). The vendor sees each service's brief, function, date/venue and requirements.
- **VND-03 (M)** **Quote structure**: a quote covers the requested service(s), with **line items mapped to requirements**, grouped by function. A line can cover a requirement fully or partially (quantity share). The quote also carries GST, validity date, terms and attachments. Lines not tied to one requirement are allowed:
  - **Service-level extras**, e.g. transport charges for the Sangeet.
  - **Package-level adjustments**, e.g. "10% off if all three functions are booked", travel or a team stay across functions.
- **VND-04 (M)** **Combined (package) quotes**:
  - **Allocation**: package-level amounts are allocated across the included services, proportionally to line amounts by default and editable. Every rupee therefore rolls up to a function, service and payer in the budget.
  - **Package conditions**: the vendor can mark a quote *all-or-nothing* or set a minimum bundle (e.g. the discount applies only if ≥ 2 functions are booked). The app warns, and recalculates, when a partial booking breaks a condition.
- **VND-05 (M)** **Quote comparison**:
  - **Per service**: combined quotes appear alongside single-service quotes with their allocated amount, labelled *part of package*.
  - **Per package**: compare package quotes against each other, and against the best mix of individual quotes for the same services.
  - Both views show per-requirement breakdown and coverage, and highlight what a quote doesn't cover.
- **VND-06 (M)** **Booking**: accept a quote fully, or select functions/lines/requirements (enabling split fulfilment across vendors). One combined quote produces **one booking** spanning several functions. Booking creates **fulfilment** records per requirement, the budget **commitment** (allocated per function/service/payer) and a draft **payment schedule** (§3.10), which is one schedule for the whole package.
- **VND-07 (M)** **Revisions**: vendors can revise a quote (versioned); changes to booked lines after booking go through budget approval (BGT-04).
- **VND-08 (M)** **Invoices on packages**: a vendor may invoice a package as one invoice or per function. Invoice lines are allocated to functions/services the same way as quotes, so budget actuals stay accurate per function.
- **VND-09 (M)** **Contracts & documents** per booking: upload (PDF/images), key terms (amount, cancellation policy, deliverables, deadlines), with reminders on key dates.
- **VND-10 (M)** **Vendor portal**: the vendor logs in with passwordless phone or email OTP (EVT-01) to see services they're invited to quote on or booked for. From there they:
  - submit and revise quotes;
  - see their requirements, functions and run-sheet items;
  - (photographers/videographers) upload photo and video deliveries to the gallery (GAL-02);
  - (caterers) see live headcount for their booked functions (RSV-06);
  - upload invoices;
  - view the payment schedule and status;
  - chat with the team.
- **VND-11 (S)** Vendor performance rating after the event, per service delivered.

### 3.9 Budget (`BGT`)
- **BGT-01 (M)** Budget is **derived from the planning structure**: Requirement → Service → Function → Event. Each level shows:
  - **Planned**: sum of requirement budget estimates.
  - **Committed**: sum of booked fulfilment amounts.
  - **Actual**: invoiced and paid amounts.
- **BGT-02 (M)** Cross-cutting views: by **service type** (e.g. total Catering across all functions), by **function**, by **vendor** and by **payer**. Extra costs not tied to a service (e.g. a gifts budget) can be added as standalone budget lines.
- **BGT-03 (M)** Allocate services or requirements to a **payer/side**: bride's family / groom's family / shared (split % or fixed amounts).
- **BGT-04 (M)** **Spend approval workflow**:
  - **Per-category thresholds**: each budget category has its own approval threshold, set by the Owner. Categories are the event's service types (Catering, Decor, …) plus categories for standalone budget lines. Example: Catering ₹2,00,000, Photography ₹75,000, Transport ₹50,000. Categories without a threshold use an event-wide default; a threshold of ₹0 means always approve.
  - **What triggers approval**:
    - a new booking/commitment (quote acceptance, VND-06) at or above the category threshold;
    - an increase to an existing commitment (quote revision, approved change to a booked requirement, extra invoice amount) where the increase is at or above the threshold;
    - any commitment that would push the category over its planned total.
    For combined quotes, each included service is checked against its own category's threshold using its allocated amount. If any part needs approval, the whole booking waits for it.
  - **Who approves, by payer**:
    - **One family pays**: one approver from that family (a Host or the Owner tagged to that side).
    - **Shared cost**: **both families must approve**, one approver from the bride's family and one from the groom's. The request shows each side's share.
    - **Fallback**: if a side has no Host/Owner in the app, the Owner approves for that side, and this is recorded in the audit log.
  - **Statuses**: pending → partially approved (awaiting the other family) → approved, or rejected. A rejection by either family rejects the request, with a mandatory comment; the requester can revise and resubmit, which restarts approvals.
  - **Blocking**: until fully approved, a booking stays *pending approval*. Fulfilments are created as tentative, the vendor sees "awaiting confirmation", and no payment schedule is activated. The Planner cannot override.
  - **Reminders**: approvers are notified (in-app plus their chosen channels) and reminded every 24 h. The approval queue shows what each family still has to approve. If payer allocation changes after approval (e.g. a cost becomes shared), the affected family must approve again.
- **BGT-05 (M)** Budget dashboard: total vs planned, by category, function and payer; variance highlights.
- **BGT-06 (M)** INR formatting with Indian grouping (₹12,34,567) and lakh/crore short form.
- **BGT-07 (M)** **Side coordinator finance view** (read-only): a Side Coordinator sees the budget and payments **where their side is a payer**.
  - **Fully paid by their side**: the full planned, committed and actual amounts.
  - **Shared costs**: only their side's share (e.g. 50% of ₹8,00,000 = ₹4,00,000), with the split shown. The other side's paid status for the shared item is shown as paid / not paid, without its payment details.
  - **Costs paid only by the other side**: not shown.
  - **Payments**: the payment schedule, invoices, paid/due/overdue status and receipts for their side's share. They also get their own side's payables report and dashboard (BGT-05 and PAY-06, filtered to their side).
  - **Bank details**: vendor bank details stay hidden (Owner/Host/Planner only).
  - **No editing**: they can't edit budget lines, record payments or approve spend, but they can comment and propose changes through the proposal workflow (SVC-10).

### 3.10 Invoices & Payment Tracking (`PAY`)
- **PAY-01 (M)** Invoices: vendor, number, date, line items, **GST** (CGST/SGST or IGST, rate, GSTIN), total, attachment; linked to a booking/budget line.
- **PAY-02 (M)** **Payment schedule** per booking: advance / milestones / final, each with amount or %, due date and payer.
- **PAY-03 (M)** Record payments: date, amount, mode (UPI, bank transfer, cheque, cash, card), reference no., payer, receipt upload.
- **PAY-04 (M)** Status per milestone and invoice: **upcoming / due / overdue / partially paid / paid**; vendor sees the same status in the portal.
- **PAY-05 (M)** Reminders for upcoming and overdue payments go to the payer side. The recipients are Owner/Host/Planner plus that side's Side Coordinator(s), configurable per event.
- **PAY-06 (M)** Payables report: what's due this week/month, by payer and vendor; export to Excel/PDF.
- **PAY-07 (C)** In-app payment collection or payout via gateway (Razorpay); **out of scope for v1**.

### 3.11 Messaging & Notifications (`MSG`)
- **MSG-01 (M)** **In-app chat**: a team channel, a thread per vendor, a thread per function; attachments, @mentions, read state.
- **MSG-02 (M)** **Guest broadcasts**: compose once, target a segment (side, tag, function invitees, RSVP status, travel group, hotel), choose channels; delivery stats.
- **MSG-03 (M)** **WhatsApp Business API** integration (via a BSP such as Gupshup, Interakt or Twilio): invites with magic link, RSVP reminders, travel/pickup updates, day-of announcements using pre-approved templates. Opt-out handling.
- **MSG-04 (M)** **Email** (transactional and broadcast) and **SMS** (DLT-registered templates for India).
- **MSG-05 (M)** In-app notification centre plus user notification preferences.
- **MSG-06 (S)** Guest replies on WhatsApp land in a shared inbox in the app.

### 3.12 Dashboards & Reports (`RPT`)
- **RPT-01 (M)** Event home dashboard: countdown, RSVP funnel, headcount per function, tasks due/overdue, budget burn, payments due, arrivals today.
- **RPT-02 (M)** Exports: guest list, headcount per function, rooming list, transfer manifests, seating chart, run sheet, budget, payables (Excel and PDF).

### 3.13 Localisation (`L10N`)
- **L10N-01 (M)** UI i18n framework from day one; **English + Hindi** in v1, structured to add regional languages (Bengali, Marathi, Tamil, Telugu, Gujarati, …).
- **L10N-02 (M)** Guest-facing pages and message templates available per language; guest language preference per household.
- **L10N-03 (M)** Timezone: event timezone (default Asia/Kolkata), shown consistently.

---

### 3.14 Gifts, Shagun & Thank-you Notes (`GFT`)
- **GFT-01 (M)** **Gift register**: record gifts per household (or per guest). Fields:
  - **Type**: cash shagun (envelope), UPI/bank transfer, cheque, gift item, gold/jewellery, voucher, other.
  - **Value**: amount in INR, or an item description with an optional estimated value.
  - **Context**: the function where it was received, received *for* (bride / groom / couple / parents / other family member), received *by* (which family member or coordinator logged it), date, notes and an optional photo of the item.
- **GFT-02 (M)** **Day-of envelope mode**: a fast mobile entry screen for whoever is collecting shagun at a function.
  - **Quick entry**: search the guest (or scan their check-in QR), enter the amount and envelope number, save, next.
  - **Unknown givers**: allowed with a free-text name.
  - **Offline**: works through poor connectivity (queued and synced, as for check-in).
- **GFT-03 (M)** **Cash reconciliation**: per collector and function, compare the recorded total with the counted cash and record the hand-over (to whom, when), with any discrepancy flagged.
- **GFT-04 (M)** **Bulk import** of post-event tally sheets from Excel, matched to households with a review step for unmatched names.
- **GFT-05 (M)** **Summaries**: totals by function, family side, received-for and gift type; a list of households with no gift recorded (for follow-up or data-entry checks). Gifts are tracked **separately from the wedding budget** and are not offset against expenses.
- **GFT-06 (S)** **Gift history across events (*vyavhar* / *lena-dena*)**: since one account can hold multiple events, show a household's gifts given and received across the family's events, to inform reciprocal gifting. Past gifts *given* can be entered manually. Limited by retention (EVT-07): history only covers events still within their 1-year window, so the archive export is the family's long-term record.
- **GFT-07 (M)** **Privacy**: gift data is visible only to the **Owner and Hosts of the receiving family side**. Side Coordinators can record gifts and see only their own entries. Planners have no access unless the Owner grants it. Guests and vendors never see gift data. Every edit is in the audit log.
- **GFT-08 (M)** **Thank-you tracker**: per household, status *not started → drafted → sent* (plus *not needed*), channel, sent date and sent by. Households that attended but gave no gift can also be thanked.
- **GFT-09 (M)** **Thank-you notes**:
  - **Templates**: per language (English, Hindi, …) with merge fields such as guest name, functions attended, gift item and a personal line. **Amounts are never inserted** into messages.
  - **Review before sending**: each note can be personalised individually; bulk send with per-household review.
  - **Channels**: WhatsApp, email or SMS through the messaging module, with delivery status tracked.
  - **Printed cards**: export names and postal addresses as Excel or a label PDF, then mark them sent manually.
- **GFT-10 (S)** **Reminders**: nudge the family when households remain un-thanked N weeks after the event (default 4 weeks); dashboard shows the % thanked.

### 3.15 Public Wedding Website (`WEB`)
- **WEB-01 (M)** **Microsite per event** at `eventhub.<domain>/<couple-slug>`, e.g. `/priya-weds-arjun`, with a mobile-first responsive layout.
- **WEB-02 (M)** **Sections** (each can be shown/hidden and reordered):
  - **Welcome**: hero with couple names, date(s), city and countdown.
  - **Our story**: text plus photos.
  - **Events**: public functions only (WEB-04), with date, time, dress code/theme and venue.
  - **Travel & stay**: getting there, recommended hotels, local tips.
  - **FAQs**: free text.
  - **Photo gallery**: pre-wedding/engagement photos uploaded by the family.
  - **Gift note**: free text, e.g. "Your blessings are our gift".
  - **Contact**: coordinator names and phone numbers, chosen by the family.
- **WEB-03 (M)** **Visibility modes**:
  - **Unlisted** (the default): anyone with the link, `noindex`.
  - **Passcode-protected**: one shared passcode, rate-limited.
  - **Public**: indexable by search engines.
  - The site can be unpublished at any time.
- **WEB-04 (M)** **Privacy controls**:
  - Each function is marked *public* (listed on the site) or *private* (shown only to invited guests). Exact venue address and map can be set to *invited guests only*.
  - The site **never** shows the guest list, RSVP data, travel/room info or gift data, except a guest's own data in personalised view (WEB-05).
- **WEB-05 (M)** **Personalised view**: opening the site from a household's magic link (GST-06) shows that household:
  - their invited functions, including private ones;
  - their RSVP form, travel/pickup and room details, and QR check-in pass.
  The site doubles as the guest portal (ITN-04).
- **WEB-06 (M)** **"Find my invitation"**: visitors without a magic link can enter their phone number or email. If it matches a household, the magic link is sent to that number/email (it is not shown on screen), so strangers cannot RSVP or see private details. Unmatched visitors see a "contact the family" message. No open self-registration in v1.
- **WEB-07 (M)** **Design & languages**:
  - **Look**: a choice of wedding theme templates (traditional, modern, minimal), colour palette, fonts, monogram/logo and cover photo.
  - **Languages**: content entered per language with a language toggle (English + Hindi in v1).
- **WEB-08 (M)** **Editor**: section-based editor with live preview, draft vs published versions, and publish/unpublish. Owner, Host or Planner can edit; **publishing needs Owner or Host**.
- **WEB-09 (M)** **Sharing**: share link with a rich preview (Open Graph image, title, date) for WhatsApp and social media. QR code of the site URL for printed invites. "Add to calendar" for public functions.
- **WEB-10 (S)** **Live updates on the day**: an announcements strip fed by broadcasts marked "show on website", plus a live-stream link/embed for remote family.
- **WEB-11 (S)** **Custom domain** (e.g. `priyawedsarjun.com`) with automatic HTTPS.
- **WEB-12 (S)** Basic visit analytics (views, link opens, "find my invitation" attempts), privacy-friendly and cookie-less.
- **WEB-13 (C)** Digital shagun via a UPI QR shown on the site (display only; the app does not process the payment). Deferred; see §8.

### 3.16 Post-event Photo Gallery (`GAL`)
- **GAL-01 (M)** **Event gallery** organised by **function** (Mehendi, Sangeet, …), with albums inside a function (e.g. "Baraat", "Pheras", "Family portraits"), sorted by capture time (EXIF). A typical wedding is 5,000–20,000 photos plus video.
- **GAL-02 (M)** **Professional deliveries**:
  - **Upload**: photographers and videographers booked for a function upload directly through the vendor portal. Bulk, resumable uploads handle thousands of files and large videos. This replaces Drive/WeTransfer links.
  - **Tracking**: each upload is tied to the booking, so the service owner can mark the requirement **delivered** (SVC-08).
  - **Drafts**: the vendor can upload a "sneak peek" set first and the full delivery later. Deliveries stay private to the family until **released**.
- **GAL-03 (M)** **Family & guest uploads**:
  - **Who**: members upload from the app; guests upload from their magic link / the personalised website, or by scanning a per-function upload QR displayed at the venue.
  - **Attribution**: every upload is tied to a household or member.
  - **Settings**: guest uploads can be turned on or off per event.
- **GAL-04 (M)** **Moderation**: guest uploads go to a moderation queue (Owner/Host/Planner approve or hide) before others can see them. Auto-approve can be switched on per event. Anyone can **request removal** of a photo they appear in; requests go to the family.
- **GAL-05 (M)** **Access**:
  - **Guests**: they see only galleries for functions they were **invited to**, following the same per-function invite rules (private functions stay private), plus their own uploads.
  - **Family**: members see everything, subject to release state.
  - **Website**: the family can pick **highlights** to show on the public wedding website (WEB-02); nothing else is public.
- **GAL-06 (M)** **Viewing & downloads**:
  - **Viewing**: fast grid and full-screen viewer on mobile, and videos stream in the browser.
  - **Downloads**: guests download single photos at web resolution. Originals and **download-all / per-album ZIP** are for the family by default; they can also be enabled for guests.
- **GAL-07 (M)** **Favourites & album selection**: family members mark favourites and build a **selection for the printed album**. The selection is shared with the photographer through the vendor portal as a list (file names) with a deadline, so it can be designed and printed.
- **GAL-08 (S)** **Likes and comments** on photos for invited guests; family can disable.
- **GAL-09 (S)** **"Find my photos" (face search)**: a guest takes a selfie and sees photos they appear in.
  - **Consent**: strictly **opt-in** with explicit consent (biometric data under the DPDP Act).
  - **Data handling**: the selfie is processed only for matching, and face data is deleted when the family closes face search or on request, and always at the retention deadline (EVT-07).
  - **Switch**: the family can disable the feature entirely.
- **GAL-10 (S)** **Watermark** option for guest-downloadable images (e.g. the couple's monogram or the photographer's credit).
- **GAL-11 (S)** **Guest notifications**: "Your photos from the Sangeet are ready" broadcast with a link, sent when a function's gallery is released.

## 4. Non-Functional Requirements

| Area | Requirement |
|---|---|
| **Responsiveness / PWA** | Mobile-first for guest, vendor and day-of screens. Installable PWA. Cached run sheet, guest lookup and check-in work through brief connectivity loss at venues. |
| **Performance** | Lists of 1,000 guests filter and search in under 300 ms (p95); pages interactive in under 2.5 s on 4G. The wedding website is statically generated/cached and loads in under 2 s on 3G-class connections, with images optimised and lazy-loaded. |
| **Scale** | ~1,000 guests, 40 vendors and ~50 staff users per event; around 100 concurrent events at launch. |
| **Security** | HTTPS everywhere; no passwords stored; OTPs are hashed, short-lived, attempt-limited and rate-limited; magic links are long, unguessable, revocable and rate-limited; role and scope checks enforced server-side; vendor bank/tax data encrypted at rest and masked in the UI. |
| **Privacy** | Personal data (phones, travel) visible only to roles that need it. **No government ID data is collected or stored** (data minimisation). **Retention: 1 year after the event, then permanent deletion** (EVT-07–09); full export available before deletion. Aligned with India's DPDP Act 2023 (consent for messaging, purpose limitation). |
| **Reliability** | Daily backups with point-in-time recovery (35-day rotation, so deletions propagate to backups within 35 days); 99.5% uptime target; message sending through a retryable job queue. |
| **Auditability** | Immutable audit log for money, RSVP and permission changes. |
| **Accessibility** | WCAG 2.1 AA for guest-facing pages; large tap targets and readable fonts for elderly guests. |
| **Files** | Documents (contracts, invoices, receipts) up to 20 MB; gallery photos (JPEG/HEIC/PNG) up to 50 MB each, videos up to 4 GB via resumable/chunked upload. Stored in object storage with signed URLs. Images get thumbnails and web-size renditions served through a CDN, with HEIC converted for browsers. |

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
      ─< ServiceType (catalogue, requirement templates)
Function ─< Service (type, owner, brief, payer allocation)
              ├─< Requirement (qty, unit, specs, when/where, estimate, priority, status)
              │       └─< Fulfilment (vendor, booking, qty/% share, agreed amount)
      ─< QuoteRequest (vendor) >─< Service   (one or many services, any functions)
              └─< Quote (versioned, GST, validity, package conditions)
                      ├─< QuoteLine (→ Requirement | Service | package-level, qty share, amount)
                      └─< Allocation (package/service-level amount → Service %)
      ─< Vendor (service types offered, GSTIN, bank*)
            └─< Booking (may span functions; accepted quote lines → Fulfilments)
                    ├─< Contract / Document
                    ├─< PaymentMilestone ─< Payment
                    └─< Invoice ─< InvoiceLine (GST)
      ─< BudgetLine (standalone costs) ─ payer allocation
      ─< CategoryThreshold (category, amount)
      ─< ApprovalRequest (booking | revision | overspend, amount, per-side shares, status)
              └─< ApprovalDecision (side, approver, approve/reject, comment, at)
      ─< Proposal (proposer, target: new Service|Requirement or change diff, status, decision by, comments)
      ─< Thread (team|vendor|function) ─< Message
      ─< Broadcast (segment, channels) ─< Delivery (status per recipient)
      ─ Website (slug, visibility, passcode_hash, theme, locales[], published_version, custom_domain?)
              ├─< WebsiteSection (type, order, visible, content per locale, media)
              └─ per-Function settings: public|private, venue visibility
      ─< GalleryAlbum (function, title, release state)
              └─< MediaItem (uploader: Member|Vendor|Household, type photo|video, original + renditions, taken_at, status pending|approved|hidden, favourites, album_selection)
      ─< MediaRemovalRequest / FaceConsent (opt-in, S)
      ─< Gift (household|free-text giver, type, amount|item, function, received_for, recorded_by, envelope_no, side)
      ─< CashHandover (collector, function, recorded vs counted, handed_to)
      ─< ThankYou (household, status, channel, template, sent_at, sent_by)
      ─< AuditLog
```

---

## 6. Key User Journeys

1. **Set up the wedding**: Owner creates the event → adds functions → invites the planner and side coordinators → applies the checklist and budget template.
2. **Build the guest list**: Coordinators import Excel → map columns → fix duplicates → tag side and groups → set per-function invites.
3. **Invite & RSVP**: Family builds and publishes the wedding website → send WhatsApp invites with personal magic links (which open the personalised site) → guests RSVP per function and member, enter travel → reminders go to non-responders.
4. **Logistics**: Planner reviews the arrivals board → creates pickup runs → allocates rooms → exports rooming lists to hotels.
5. **Services → vendors → money**: For each function, add services and their requirements (with estimates) → request quotes per service, or one combined request across functions (e.g. Catering for all functions) → compare per requirement → book one vendor, or split a requirement across vendors (creates fulfilments, budget commitment and payment schedule) → gap view shows anything still uncovered → above the category threshold, the paying family approves (both families for shared costs) → vendor uploads invoice in the portal → payer records payment → vendor sees "Paid".
6. **Day-of**: Coordinators open the run sheet in live mode on their phones → check guests in by QR → broadcast "Baraat starts in 15 min" to groom-side guests → shagun collectors log envelopes in envelope mode and reconcile cash after each function.
7. **After the wedding**: Family reviews gift summaries → drafts personalised thank-you notes from templates → sends via WhatsApp/email or prints cards → tracker shows who is still to be thanked. Photographers upload deliveries → family reviews and releases each function's gallery → guests are notified and browse/download their functions' photos → family picks album selections for the photographer.

---

## 7. Technical Direction

- **Frontend/Backend**: Next.js (App Router, TypeScript), React Server Components plus server actions/route handlers; Tailwind CSS with an accessible component library (e.g. shadcn/ui).
- **Database**: PostgreSQL via Prisma. Every event-scoped table carries `event_id`; authorisation is centralised in a policy layer (role + side/function scope).
- **Auth**: passwordless OTP via phone (SMS through an Indian DLT-compliant provider such as MSG91 or Twilio Verify, plus WhatsApp authentication templates) or email. Implemented as a custom OTP provider on Auth.js, or a managed service. Database-backed sessions; signed, revocable tokens for guest household links.
- **Background jobs**: Queue (e.g. BullMQ/Redis or pg-boss) for messaging, reminders, imports and exports.
- **Integrations**: WhatsApp BSP, email provider (Resend/SES), SMS provider with DLT templates, object storage (S3-compatible) with a CDN and an image-processing pipeline (e.g. `sharp` workers for thumbnails/renditions, video transcoding via a managed service); tus/S3 multipart for resumable uploads.
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
- Digital shagun collection on the wedding website (WEB-13).
- **Guest ID collection**: the app does **not** collect, upload or store guest ID proofs or ID numbers (Aadhaar, passport, PAN, …). Hotels collect IDs directly from guests at check-in. Guest forms and file uploads offer no ID fields, and the guest messaging templates tell guests to carry their ID to the hotel.

---

## 9. Delivery Plan

All modules ship in **Phase 1**, built in this order so each milestone is usable and testable:

| Milestone | Scope |
|---|---|
| **M1 Foundation** | Auth, events, members, roles and scoping policy layer, audit log, i18n scaffold, PWA shell, dashboard skeleton |
| **M2 Guests & Itinerary** | Households/guests, import/export, tags/sides, functions, master schedule, per-function invites, tasks |
| **M3 Guest Experience** | Magic links, RSVP, personalised itinerary, guest travel submission, Hindi guest pages, public wedding website (editor, themes, visibility, personalised view) |
| **M4 Logistics** | Travel, transfers, hotels/room blocks, room allocation, seating plans, QR check-in |
| **M5 Services, Vendors & Money** | Service catalogue, services & requirements per function, fulfilment/gap view, vendor directory, quotes per service and comparison, contracts, budget (categories/functions/payer), approvals, invoices with GST, payment schedules/status |
| **M6 Communication** | In-app chat, vendor portal, broadcasts, email/SMS/WhatsApp integration, reminders, gift register & envelope mode, thank-you notes |
| **M7 Post-event & Hardening** | Photo gallery (deliveries, guest uploads, moderation, album selection), retention jobs (reminders, full archive export, scheduled deletion incl. storage and backups), run sheet live mode, offline check-in, reports/exports, performance, security review, UAT on a real wedding dataset |

**Lead-time risk:** WhatsApp Business API approval (Meta business verification, template approval) and SMS **DLT registration** take days to weeks. Start these during M1. **Phone OTP login depends on them**, so email OTP ships first in M1 and phone OTP switches on as soon as the DLT template is approved.

---

## 10. Assumptions

- Families use one or more planners or tech-comfortable coordinators; elders mainly use guest magic links or are handled by coordinators.
- One event typically has 5–8 functions over 2–4 days, sometimes across multiple venues/cities.
- Vendors invoice in INR with GST; some small vendors have no GSTIN (GST fields optional).
- Payments happen outside the app (UPI/bank/cash); the app records them as the system of record.

---

## 11. Open Questions (to resolve before/during M1)

1. **Branding**: product name "EventHub" final? Any visual identity or theme preferences (e.g. per-event colour themes for invites)?
2. **Hosting/budget constraints** for third-party services (WhatsApp per-message cost, SMS, email) and **gallery storage**: is there a per-event storage cap (e.g. 200 GB) or video size limit? Photo/video storage and bandwidth will be the largest running cost.
