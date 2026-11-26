# Sparked Dev FHIR Server: Participant Handout

This handout was written for the July 2026 Test Event and no longer describes the
server, so its content has been replaced by this pointer.

For the HL7 Australia WGM and Melbourne FHIR Connectathon (8 to 10 December 2026),
use the [participant guide](participants/2026-12-melbourne.md). It covers the
endpoints, SMART discovery, the test data, the writable event sandboxes, the
change freeze and the known issues, and it is kept current for the event.

What changed since the July handout, in short:

- The shared `DEFAULT` partition has been read-only for participants since
  2026-08-19, with or without a token.
- The `ereq` node was decommissioned on 2026-08-03; `aucore` is the only node.
- SMART discovery is served under the FHIR base:
  `https://smile.sparked-fhir.com/aucore/fhir/DEFAULT/.well-known/smart-configuration`.
- `connectathon-backend-02` has been read-only since 2026-07-15.

The July 2026 text is in git history at commit `5c24db1`
(`docs/connectathon-participant-handout.md`).
