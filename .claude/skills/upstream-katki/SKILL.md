---
name: upstream-katki
description: |
  The procedure for contributing to another repository from this project. Search the target
  repo's open and closed PRs and issues first, read its contribution rules before writing the
  patch, search again right before posting, and reference other repos as owner/repo#NNN. Use
  it before writing any patch, PR, issue or comment for a repository other than this one,
  including when the user says "PR aç", "issue aç", "upstream'e gönder", "katkı yap",
  "yorum yaz", "open a PR", "file an issue" or "report this upstream".
---

# Contributing upstream

This procedure moved here from CLAUDE.md so it loads only when a contribution
is in progress. The public-writing rules in CLAUDE.md still apply to every PR
body, issue and comment.

## Check it is not already filed
Before writing any patch, search the target repo's open AND closed PRs and
issues for the same finding. Closed matters as much as open. A maintainer
who has already closed three duplicates of one PR will close a fourth.

If someone has said it already, we do not send a second one. We comment on
theirs only if we have evidence they lack. A confirming comment on a
correct PR is noise.

Search again immediately before posting, not only before drafting. A check
goes stale. In an active repo a thread can gain a substantive reply within
hours, and a comment written against a three-day-old reading can repeat or
contradict what is already there. Re-read the target thread in full, then
post.

## Read the rules, on the first contribution to a repo
Read these BEFORE writing the patch, not after opening it:

- CONTRIBUTING.md
- SECURITY.md, and decide whether the finding belongs in a private
  advisory rather than a public issue or PR
- AGENTS.md, or whatever the repo calls its rules-for-editors file
- .github/pull_request_template.md and .github/ISSUE_TEMPLATE/*

Then report to me what they require. A --body-file silently overwrites a
PR template, and a checklist item like a CHANGELOG entry is easy to miss
once the PR is already open.

## Reference other repos by full name
Cross-repo references in commit messages, PR bodies and issue bodies use
owner/repo#NNN, never a bare number. A bare reference resolves against
whatever repo it is read in. It looks correct locally and misleads
everywhere else, and the failure can lie dormant for years, surfacing the
day the wrong repo reaches that number.
