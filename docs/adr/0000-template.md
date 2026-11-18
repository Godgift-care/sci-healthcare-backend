# ADR-0000: Template

A record of one decision that is hard to reverse and surprising to read the
code without. Copy this file to `NNNN-<kebab-case-title>.md`, where `NNNN` is
the next number after the highest one already in this directory.

Write it after the decision, not before — these records exist to explain code
that already behaves a certain way, and a record of an unmade decision goes
stale the moment the implementation disagrees with it.

## What earns a record

- **Reversing it would cost real work.** A stored format, a wire contract, a
  concurrency protocol. Dropping a dependency is not this.
- **A reader cannot infer it from the code.** The code shows *what* it does;
  the record is for *why that and not the obvious alternative*.
- **Someone has already asked.** If a contributor re-litigates it in a pull
  request, that is the signal the reasoning was not findable.

Three or four paragraphs is enough. The Consequences section is the one people
skip and the one that matters most: it is where the costs are admitted.

## Structure

```markdown
# ADR-NNNN: <decision as one sentence>

**Status:** Accepted | Superseded by ADR-XXXX | Deprecated
**Date:** <YYYY-MM-DD, the date the decision was made>
**Code:** <the files that carry the decision>

## Context

What problem was on the table, and the constraints that were not negotiable.
Facts and pressures only — no justification for the choice yet.

## Decision

What was decided, in active voice, and what that rules out. Name the
alternatives that were rejected and why, in one line each.

## Consequences

What is now true because of this, including the costs. Split into what gets
easier and what gets harder or is now a standing obligation. A consequence
that has to be re-checked whenever something changes belongs here even when it
is unwelcome — that is what the section is for.
```
