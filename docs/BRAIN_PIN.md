# The shared Brain pin — read this before bumping `sense-ai-brain`

**Audience:** anyone (human or AI agent) about to change the `oracle/packages/sense-ai-brain`
submodule, in this repo or in `sense-ai-core`.

## The rule

`@tradableapp/sense-ai-brain` is the **one** analytical powerhouse that both bodies share:

| Body | Repo | Submodule path |
| --- | --- | --- |
| Oracle | `tokenized-ai-agent` | `oracle/packages/sense-ai-brain` |
| Social | `sense-ai-core` | `packages/sense-ai-brain` |

**Both bodies must pin the same Brain commit.** A submodule pin is per-repo, so nothing in git
enforces this — the two can drift apart and keep compiling. That is not hypothetical: on
**2026-07-27** the oracle sat on `20a356c`, core on `2271455`, and the Brain's `main` was on
`18f3008` — three different commits, no failure anywhere.

Divergent pins are how "no re-fork" dies quietly. Both bodies keep building, but they are
running *different* Brains, so shared analytical logic starts behaving differently in each — and
the whole point of the Brain is that it behaves identically for both.

## Bumping it

Do both repos **in the same change** (a PR pair, merged together):

```bash
# 1. In each body, move the submodule to the new commit
git submodule update --init --recursive <submodule-path>
cd <submodule-path> && git fetch origin && git checkout <NEW_SHA> && cd -
git add <submodule-path>

# 2. Update the guard's constant in the SAME commit
#    tokenized-ai-agent: oracle/test/brainPin.test.js  → EXPECTED_BRAIN_SHA
#    sense-ai-core:      see its equivalent pin guard
```

Updating the constant is deliberately required: it puts the new SHA in a **test diff**, where a
reviewer sees it, and makes the matching bump in the other body an explicit step rather than
something remembered.

## What the guard does and does not catch

`oracle/test/brainPin.test.js` asserts two things, both offline and CI-runnable:

1. The gitlink **in the index** matches `EXPECTED_BRAIN_SHA` — catching an unreviewed pin move
   inside this repo (a stray `git submodule update --remote` that gets committed).
2. `.gitmodules` still points at `https://github.com/TradableApp/sense-ai-brain` — catching the
   most literal re-fork, repointing at a personal fork, which a SHA-only check would miss.

It reads the **index** rather than `HEAD` so a staged bump is validated before it lands; after a
fresh CI checkout the two are identical.

**It cannot compare against `sense-ai-core`.** CI checks out only this repo and its submodules —
the sibling is not present. Keeping the two constants equal is therefore a **review step**, not
an automated one. To check locally, with both repos as siblings:

```bash
cd "$(git rev-parse --show-toplevel)/.."
echo "oracle: $(git -C tokenized-ai-agent ls-files -s -- oracle/packages/sense-ai-brain | awk '{print $2}')"
echo "core  : $(git -C sense-ai-core      ls-files -s -- packages/sense-ai-brain        | awk '{print $2}')"
```

Those two SHAs must be equal. If they are not, the bodies have drifted — fix that before
trusting any conclusion about shared analytical behaviour.

## Related

- Epic **CU-86d3dwme6** (Oracle Brain migration), task **CU-86d3ud1va** (Brain parity).
- Plan: [`.claude/PRPs/plans/brain-powerhouse-two-bodies.md`](../.claude/PRPs/plans/brain-powerhouse-two-bodies.md)
  — the target architecture and why only body-specific glue stays in each repo.
- The Brain's own architecture decision: `oracle/packages/sense-ai-brain/docs/decisions/0001-brain-architecture.md`.
