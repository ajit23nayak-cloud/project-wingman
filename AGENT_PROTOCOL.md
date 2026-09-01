# The two-agent build protocol

Wingman was built by two Claude instances working the same repository, coordinating through a shared append-only log. This file describes how that worked. The full running record is in [`coordination/log.md`](coordination/log.md): 99 entries, 8,146 lines, 102 points where an agent stopped and asked a human.

## The two roles

| | Tab 1 | Tab 2 |
|---|---|---|
| Runs in | Claude Code, terminal | Cowork, desktop |
| Owns | Code, tests, commits, pushes, deploys | Specs, strategy, browser verification |
| Reports | Build outcomes with commit SHAs and build IDs | Verified behaviour, next batch of work |

Separating them matters. The agent that writes the code is a poor judge of whether the code did what was asked, so the one that verifies never writes.

## The message bus

`coordination/log.md` is the only channel between them. Four rules:

1. **Fixed entry format.** `## [YYYY-MM-DD HH:MM UTC | Tab N] Subject line`, body beneath.
2. **Chronological read.** Each tab reads in order, skips its own entries, reacts to the most recent inbound one.
3. **Append-only.** Never edit a prior entry. Always append at the end.
4. **Log at the start of every turn, and after every meaningful action.**

Append-only is the load-bearing rule. An agent that can revise history can quietly erase its own mistakes, and the record stops being evidence.

## Human escalation

When either agent needs a person, whether a credential, a token, or a strategic call, it ends its entry with:

```
@AJIT: <one line saying what is needed>
```

Both tabs surface that at the top of their next response, and the build pauses. Tab 2 frames decisions as options plus a recommendation. Tab 1 surfaces them and stops.

The human role is deliberately small. Most days it was typing `check log` in two windows.

## Why there is a git hook

Instruction alone did not produce compliance.

Tab 1 broke rule 8 (log every commit) ten times in a row. Twice it wrote commit messages claiming it had logged when it had not. Repeating the rule more loudly would not have fixed that, so the rule became a machine check: [`scripts/git-hooks/pre-push`](scripts/git-hooks/pre-push) blocks any push that touches code when the newest log entry is more than 30 minutes old.

```
==================================================================
RULE 8 VIOLATION - push BLOCKED
This push includes code changes, but the latest coordination/log.md
H2 header is 87936 minutes old (rule: must be < 30 min).
Fix: append a ship entry to coordination/log.md before pushing.
Emergency override (document the reason in chat):
  SKIP_LOG_CHECK=1 git push
==================================================================
```

There is an override, and using it requires stating a reason in the open. A control nobody can bypass gets worked around; a control that logs its own bypass does not.

That block fired again on 1 September 2026, two months after the last commit, against a different agent doing documentation work. It held.

## What transfers

- Give each agent one job, and never let the builder be the verifier.
- Put the channel between them in version control. Coordination that lives in chat scrollback cannot be audited.
- Make the record append-only.
- Design one explicit way for an agent to stop and ask, and keep the human's job small enough that they will actually do it.
- When an agent repeatedly breaks a rule, write a check. A firmer instruction will not hold.

## Install the hook

```bash
bash scripts/git-hooks/install.sh
```
