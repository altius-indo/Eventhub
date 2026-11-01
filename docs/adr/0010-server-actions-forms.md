# ADR-0010: Server actions with SimpleForm

- **Status**: Accepted
- **Date**: 2026-11-01

## Context

React 19 resets uncontrolled forms after an action, so a validation error wiped what the user typed. Buttons with their own `formAction` have their `name` overwritten by React, so their values never reach the action.

## Options considered

- Client-side form libraries for every form.
- Server actions plus a small wrapper.

## Decision

Mutations are server actions in colocated `actions.ts`, validated with zod, returning `{ error?, info? }`. `SimpleForm` submits through `startTransition` (keeping typed values on error, resetting on success) and supplies pending state to `SubmitButton`. Identifiers are passed with `.bind(...)`, never via button `name/value` when using `formAction`. Success after redirect uses a query flag.

## Consequences

Progressive enhancement for one-click forms; consistent error display. Every new form follows this; `code-reviewer` checks it.
