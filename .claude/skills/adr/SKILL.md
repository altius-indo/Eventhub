---
name: adr
description: Record an architecture decision for EventHub as a numbered ADR in docs/adr. Use when choosing between technical options (libraries, data model, security approach, integration pattern) or when reversing an earlier decision.
argument-hint: "[decision title]"
---

# Architecture decision record: $ARGUMENTS

1. Look at `docs/adr/README.md` for the next number and for related ADRs. If the new decision replaces
   one, set the old one's status to `Superseded by ADR-NNNN` and link both ways.
2. Copy `docs/adr/template.md` to `docs/adr/NNNN-kebab-title.md` and fill it in:
   - **Context**: the forces: requirement IDs, constraints, what broke or what we learned.
   - **Options**: 2–4 real alternatives with honest trade-offs.
   - **Decision**: what we do, stated plainly.
   - **Consequences**: what gets easier, what gets harder, and what would make us revisit.
   Keep it under a page. Write for someone joining the project in six months.
3. Add a row to the index table in `docs/adr/README.md`.
4. If the decision changes a convention, update `CLAUDE.md` or the matching `.claude/rules/*.md`.
