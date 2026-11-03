# ADR-0015: Printable HTML pages instead of server-generated PDFs

- **Status**: Accepted
- **Date**: 2026-11-01
- **Requirements**: ITN-07

## Context

Run sheets, manifests, seating plans and itineraries must be exportable to PDF, in English and
Hindi, from phones and laptops. Devanagari needs complex text shaping (conjuncts, matras) that
server PDF libraries (pdfkit, react-pdf) render badly without extra font-shaping builds.

## Options considered

- Server PDF library: one file to attach, but poor Hindi and new dependencies.
- Headless Chromium on the server: perfect output, but heavy to run and operate.
- Print-optimised HTML (`@media print`, A4) that the browser prints or saves as PDF.

## Decision

`…/print` pages with print CSS (app chrome hidden, `break-inside: avoid`, printed-at time) and a
"Print / save as PDF" button calling `window.print()`.

## Consequences

Correct Hindi, reuses the i18n formatters, no new dependency or server CPU. Output varies slightly by
browser, and there's no server-side file to attach to messages. Revisit with headless Chromium in the
job worker if milestone 6 broadcasts need attached PDFs or milestone 7's archive needs server PDFs.
