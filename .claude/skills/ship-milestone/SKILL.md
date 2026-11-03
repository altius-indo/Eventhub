---
name: ship-milestone
description: Finish a milestone or feature for EventHub - run every check, verify in the browser, update docs, commit with requirement IDs and push the feature branch. Use when the user asks to wrap up, commit or ship work.
disable-model-invocation: true
argument-hint: "[milestone or feature name]"
---

# Ship: $ARGUMENTS

1. `npm run typecheck && npm run lint && npm test` all green. Report the test count.
2. `npm run build` compiles.
3. `e2e-check` skill on the changed flows; read the screenshots.
4. Ask the `code-reviewer` agent (and `security-reviewer` if auth, guests, money, uploads or public
   pages changed) to review `git diff`; fix real findings.
5. Update the README "Status" section in user-facing language, plus any new scripts. Change
   `docs/REQUIREMENTS.md` only for scope decisions the user agreed to.
6. `git status`: no secrets, `.env`, screenshots or scratch files staged.
7. Commit: a subject (`Milestone N: …` or an imperative summary), bullets naming the requirement IDs
   covered, then the attribution lines from the session's system reminder.
8. Push the session's feature branch with `git push -u origin <branch>`. Not the default branch,
   no force.
9. Tell the user what was built, what changed from the plan and why, what's not done yet, and
   what's next, in plain language.
