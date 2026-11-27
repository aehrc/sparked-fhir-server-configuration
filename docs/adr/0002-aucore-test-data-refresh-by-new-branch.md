# ADR 0002: Refresh the AU Core test data by a new branch, never by rewriting the installed one

- **Status**: Accepted
- **Date**: 2026-11-26
- **Deciders**: the Sparked environment owner (review of aehrc/sparked-fhir-server-configuration#130, call c1)
- **Technical scope**: the AU Core data set on `aucore` `DEFAULT`, loaded by the
  test data loader (`aehrc/sparked-test-data-loader`) from a Sparked branch of
  `aehrc/au-fhir-test-data`.

## Context

The upstream AU Core folder of `hl7au/au-fhir-test-data` does not load on
`aucore` as it stands: eight examples claim an AU eRequesting profile `aucore`
cannot resolve, and `Patient/roberts-fred` is referenced from AU Core but
defined only in AU eRequesting. The loader therefore reads a Sparked branch of
the `aehrc` fork carrying those fixes, by branch name (`gitBranch` in the
loader's values).

Until November 2026 the IG release runbook refreshed that branch by rebasing
`sparked-aucore-loadable` onto upstream `master` and force-pushing it. By then
the branch was 147 commits behind upstream, and the refresh for the December
2026 event was the first one due.

## Decision

Each refresh cuts a new branch, `sparked-aucore-loadable-<yyyy-mm>`, from
upstream `master` with only the fixes still needed picked on top, and a loader
values PR points the AU Core `gitBranch` at it. The installed branch is never
rebased or force-pushed. The loader's values are the one record of which branch
is tracked; runbooks read it from the loader's public datasets API rather than
naming it. Old branches are deleted only once nothing has them installed and the
event they served is over.

The December 2026 refresh made `sparked-aucore-loadable-2026-11` (upstream
`af8a563`), replacing `sparked-aucore-loadable` (upstream `ecc2ff7`).

Rejected: rebase one branch in place and tag the old head. It needs no loader
change per refresh, but a rollback then needs a force-push, possibly in event
week, and the loaded commit disappears from the branch the loader names.

## Consequences

- Rollback is reverting the values PR and running Update Now, with no git
  rewriting.
- Every refresh costs a loader values PR and a loader pod restart, and leaves an
  old branch to prune after the event.
- The procedure lives in `docs/runbooks/ig-release.md` steps 3.1 and 3.2 and in
  the loader's `docs/refreshing-test-data.md`.

**What would reopen it**: upstream taking both fixes, which retires the Sparked
branch and points the loader back at `hl7au` `master`.
