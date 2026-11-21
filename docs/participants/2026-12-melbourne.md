# HL7 Australia Work Group Meeting and FHIR Melbourne Connectathon: Sparked participant guide

<!-- Generated from events/2026-12-melbourne.yaml by scripts/render_event.py. Do not edit by hand: change the manifest or events/templates/, then re-render. -->

_Facts in this guide were last checked on Sat 21 Nov 2026._

This guide covers the services the Sparked program runs for the event: the Sparked FHIR server, the hosted Inferno test kits and the terminology servers, and writable sandboxes if they go ahead. For the agenda, tracks and venue, see the [event page](https://confluence.hl7.org/pages/viewpage.action?pageId=494872196).

Everything here holds **synthetic test data only**. Never send real patient or personal data to any of these services.

## At a glance

| | |
|---|---|
| Event | HL7 Australia Work Group Meeting and FHIR Melbourne Connectathon (Melbourne FHIR Connectathon #28) |
| Dates | Tue 8 to Thu 10 Dec 2026 |
| Venue | Melbourne Connect, 700 Swanston Street, Carlton VIC 3053 |
| Sparked FHIR server | `https://smile.sparked-fhir.com/aucore/fhir/DEFAULT` |
| HL7 AU reference server | `https://fhir.hl7.org.au/aucore/fhir/DEFAULT` |
| Inferno | https://inferno.hl7.org.au |
| Sandboxes | Planned, not yet confirmed (Go/no-go on Mon 30 Nov 2026) |
| Change freeze | Fri 4 Dec 2026, 17:00 AEDT to Fri 11 Dec 2026, 17:00 AEDT |
| Help | [Sparked FHIR Server topic on Zulip](https://chat.fhir.org/#narrow/channel/179173-australia/topic/Sparked.20FHIR.20Server) |

Programme:

- Tue 8 Dec 2026: HL7 Australia Work Group Meeting
- Wed 9 Dec 2026: FHIR Connectathon, day 1
- Thu 10 Dec 2026: FHIR Connectathon, day 2

## Endpoints

| | Sparked FHIR Server (aucore) | HL7 AU reference FHIR server |
|---|---|---|
| Run by | CSIRO, for the Sparked program | HL7 Australia (not run by Sparked) |
| FHIR base | `https://smile.sparked-fhir.com/aucore/fhir/DEFAULT` | `https://fhir.hl7.org.au/aucore/fhir/DEFAULT` |
| Access | Anonymous read and search, $validate and $summary on the shared DEFAULT partition, which is read-only for participants. | Anonymous read and search. The default target of the Inferno AU Core Test Kit. |
| Software | Smile CDR 2026.05.R01 | Smile CDR 2026.02.R02 |
| SMART configuration | `https://smile.sparked-fhir.com/aucore/fhir/DEFAULT/.well-known/smart-configuration` |  |

**Two servers share the same path.** `smile.sparked-fhir.com/aucore/fhir/DEFAULT` (Sparked) and `fhir.hl7.org.au/aucore/fhir/DEFAULT` (HL7 AU reference server) look alike but are separate systems, run by different teams, holding different IG versions. Check the host before you report a problem, and report it in the right place (see [Help](#help)).

The Sparked server's `DEFAULT` partition is read-only for participants. Reads, searches, `$validate` and `$summary` need no login. Writable sandboxes are planned but not yet confirmed (see [Sandboxes](#sandboxes)); until they open, there is nowhere on the Sparked server to write.

**Not on the Sparked server.** Some event tracks use IGs that Sparked does not serve:

- **AU eRequesting 1.0.0**: `https://fhir.hl7.org.au/ereq/fhir/DEFAULT` on the HL7 AU reference FHIR server (not run by Sparked), checked Sat 21 Nov 2026. Sparked's own eRequesting endpoint (`smile.sparked-fhir.com/ereq`) was retired in August 2026 and answers 404. Ask in the AU eRequesting track topic on Zulip (see [Help](#help)) which server the track uses.

## Version map

The Sparked FHIR server carries the latest AU ballots (AU Core 3.0.0-ballot1, AU Base 7.0.0-ballot1), and the HL7 AU reference server carries the current trial-use release (AU Core 2.0.0). Neither changes for this event. Build to AU Core 2.0.0? Use fhir.hl7.org.au or a local validator. Trying the ballot? Use Sparked.

| IG | Sparked FHIR Server (aucore) | HL7 AU reference FHIR server |
|---|---|---|
| AU Core | **3.0.0-ballot1** (ballot, used when no version is given)<br>**2.1.0-draft** (draft) Older draft, still loaded.<br>not loaded: 2.0.0 | **2.0.0** (trial-use, used when no version is given)<br>not loaded: 3.0.0-ballot1 |
| AU Base | **7.0.0-ballot1** (ballot, used when no version is given)<br>**6.1.1-draft** (draft) Older draft, still loaded.<br>not loaded: 6.0.0 | not checked |
| AU Patient Summary | **1.0.0** (trial-use) | **1.0.0** (trial-use) |
| International Patient Summary | **2.0.1** (trial-use) | not checked |

Server holdings last checked: Sparked FHIR Server (aucore) Sat 21 Nov 2026; HL7 AU reference FHIR server Sat 21 Nov 2026.

### Validating against a specific version

Add the profile, with its version, to `$validate`. Without `profile` the Sparked server checks base FHIR only.

```bash
curl -s -X POST \
  -H 'Content-Type: application/fhir+json' \
  --data @my-patient.json \
  'https://smile.sparked-fhir.com/aucore/fhir/DEFAULT/Patient/$validate?profile=http://hl7.org.au/fhir/core/StructureDefinition/au-core-patient|3.0.0-ballot1'
```

Profiles to use on each server for this event:

- Sparked FHIR Server (aucore):
  - AU Core 3.0.0-ballot1: `http://hl7.org.au/fhir/core/StructureDefinition/au-core-patient|3.0.0-ballot1`
  - AU Core 2.1.0-draft: `http://hl7.org.au/fhir/core/StructureDefinition/au-core-patient|2.1.0-draft`
  - AU Base 7.0.0-ballot1: `http://hl7.org.au/fhir/StructureDefinition/au-patient|7.0.0-ballot1`
  - AU Base 6.1.1-draft: `http://hl7.org.au/fhir/StructureDefinition/au-patient|6.1.1-draft`
  - AU Patient Summary 1.0.0: `http://hl7.org.au/fhir/ps/StructureDefinition/au-ps-patient|1.0.0`
  - International Patient Summary 2.0.1: `http://hl7.org/fhir/uv/ips/StructureDefinition/Patient-uv-ips|2.0.1`
- HL7 AU reference FHIR server:
  - AU Core 2.0.0: `http://hl7.org.au/fhir/core/StructureDefinition/au-core-patient|2.0.0`
  - AU Patient Summary 1.0.0: `http://hl7.org.au/fhir/ps/StructureDefinition/au-ps-patient|1.0.0`

Each canonical above is one example profile from its IG; any other profile from the same IG takes the same `|version` suffix.

## Terminology

- **Sparked development terminology server**: `https://tx.dev.hl7.org.au/fhir`. Ontoserver with SNOMED CT-AU and the AU terminology content. Its nightly content preload is paused for the freeze window.
- **HL7 AU reference terminology server**: `https://tx.hl7.org.au/fhir`. Ontoserver run for HL7 Australia; the stable counterpart.

## Test data and identifiers

The shared `DEFAULT` partition of the Sparked FHIR server holds the HL7 AU test data, loaded on Mon 24 Aug 2026:

- **AU Core**: [`aehrc/au-fhir-test-data` at `20fb514`](https://github.com/aehrc/au-fhir-test-data/tree/20fb5141d4433ca074f93f13cdcbb21b5477d8d7/au-fhir-test-data-set/au-core) (`sparked-aucore-loadable`). A Sparked branch of hl7au/au-fhir-test-data: upstream master at ecc2ff7 plus three commits that make the set loadable on this server.
- **AU Patient Summary**: [`hl7au/au-fhir-test-data` at `ecc2ff7`](https://github.com/hl7au/au-fhir-test-data/tree/ecc2ff75656354da5042cc4f72accd816859a511/au-fhir-test-data-set/au-patient-summary) (`master`).

No reload is planned before the event; the data stays as loaded through the freeze.

The upstream source is [hl7au/au-fhir-test-data](https://github.com/hl7au/au-fhir-test-data) (CC0). Load the same files into your own server with any FHIR client.

Look a resource up by id or by identifier, for example:

```bash
curl -s 'https://smile.sparked-fhir.com/aucore/fhir/DEFAULT/Patient/hennessy-billy'
curl -s 'https://smile.sparked-fhir.com/aucore/fhir/DEFAULT/Patient?identifier=http://ns.electronichealth.net.au/id/hi/ihi/1.0|8003608333660645'
curl -s 'https://smile.sparked-fhir.com/aucore/fhir/DEFAULT/Practitioner?identifier=http://ns.electronichealth.net.au/id/hi/hpii/1.0|8003611566719005'
```

About the identifiers in this data (from the [AU test data documentation](https://github.com/hl7au/au-fhir-test-data/blob/master/docs/README.md#synthetic-data-properties)):

- **IHI, HPI-I and HPI-O** numbers come from Services Australia and are reserved for testing in the HI Vendor Test Environment.
- **Medicare card numbers, Medicare provider numbers, PBS prescriber numbers and DVA numbers** come from Services Australia but are **not reserved for testing**. Some may coincide with numbers assigned to real people. Do not use them anywhere outside a test system, and never send them to a production system or an external integration.
- **Ahpra registration numbers** carry a profession prefix (`HAC`) that is not linked to a real profession.
- **ABNs** are deliberately invalid.
- Names are fictional. Addresses are built from real address parts and may match real places.

## Sandboxes

Writable sandboxes for this event are **planned, not yet confirmed**. Go/no-go on Mon 30 Nov 2026 decides whether they go ahead, and this section is updated with the outcome. Until then, what follows is the plan.

A sandbox is your own writable space on the Sparked FHIR server, with its own FHIR base URL, clients and starter data, separate from every other participant's.

**Getting one.** Go to https://sandbox.sparked-fhir.com and enter the event access code. From Wed 2 Dec 2026, 09:00 AEDT, the code is in the organisers' pre-event message to registered participants. If you did not get that message, ask in the Sparked FHIR Server topic on Zulip (see [Help](#help)) and the Sparked team sends you the code by Zulip direct message. During the event it is also on the venue slides and in the printed guide. Please do not post the code in a Zulip channel. There is no account to create and no GitHub login.

The code is not in this guide.

**What you get**, all shown on your sandbox page:

- a FHIR base URL for your sandbox on `smile.sparked-fhir.com`
- a backend services client (client id and secret; the secret is shown once, and you can rotate it)
- a login user and a public PKCE client for SMART App Launch, with the redirect URIs you enter
- AU Core starter data, with resource ids prefixed by your sandbox id
- a **Reset** button that clears your sandbox and reloads the starter data

**Dates.** Sandboxes can be created from Wed 2 Dec 2026, 09:00 AEDT until Thu 10 Dec 2026, 17:00 AEDT. Every sandbox for this event expires on Thu 17 Dec 2026, 17:00 AEDT; its clients and login user are disabled and its data is deleted.

**Limits.** Up to 10,000 resources in one sandbox, and 60 sandboxes in total for the event. Synthetic data only: the Sparked team can see everything in every sandbox.

## Auth recipes

The Sparked server's discovery documents ([SMART configuration](https://smile.sparked-fhir.com/aucore/fhir/DEFAULT/.well-known/smart-configuration), [OpenID configuration](https://smile.sparked-fhir.com/aucore/smartauth/.well-known/openid-configuration)) advertise grant types `authorization_code` and `client_credentials`, confidential clients with a shared secret (`client-confidential-symmetric`) and public clients with PKCE `S256`. They list only `openid` and `fhirUser` in `scopes_supported` and advertise neither `permission-v1` nor `permission-v2`.

| | URL |
|---|---|
| SMART configuration | `<FHIR base>/.well-known/smart-configuration`, for example `https://smile.sparked-fhir.com/aucore/fhir/DEFAULT/.well-known/smart-configuration` |
| Issuer | `https://smile.sparked-fhir.com/aucore/smartauth` |
| Authorize | `https://smile.sparked-fhir.com/aucore/smartauth/oauth/authorize` |
| Token | `https://smile.sparked-fhir.com/aucore/smartauth/oauth/token` |
| Signing keys (JWKS) | `https://smile.sparked-fhir.com/aucore/smartauth/jwk` |

### No auth: read the shared data

```bash
curl -s 'https://smile.sparked-fhir.com/aucore/fhir/DEFAULT/Patient?_count=5'
```

The recipes for backend services, bearer tokens and SMART App Launch need a client on a sandbox. They are added here if sandboxes go ahead; see [Sandboxes](#sandboxes).

### Testing your own server in Inferno: bearer token or custom header

The AU Core and AU PS test suites in Inferno take either an access token for your server (the **OAuth Credentials** input) or a custom header such as an API key (the **Header name** and **Header value** inputs). Use one or the other, and use a token or key issued for a test system holding synthetic data, because Inferno sessions are open to anyone with the link.

## Inferno

The AU test kits are hosted at [inferno.hl7.org.au](https://inferno.hl7.org.au).

Release v1.2.3 is planned for this event and is not on the site yet; the site runs v1.2.2 today. Once promoted, the site stays on v1.2.3 through the change freeze ([promotion](https://github.com/hl7au/au-fhir-inferno/pull/223)).

| Kit | Version for the event | On the site today | Suites |
|---|---|---|---|
| [AU Core Test Kit](https://inferno.hl7.org.au/test-kits/au-core/) | 1.4.7 | 1.4.6 | [AU Core v3.0.0-ballot1](https://inferno.hl7.org.au/suites/au_core_v300_ballot1)<br>[AU Core v2.1.0-draft](https://inferno.hl7.org.au/suites/au_core_v210_draft)<br>[AU Core v2.0.0](https://inferno.hl7.org.au/suites/au_core_v200)<br>[AU Core v1.0.0](https://inferno.hl7.org.au/suites/au_core_v100) |
| [AU PS Test Kit](https://inferno.hl7.org.au/test-kits/au-ps/) | 1.0.1 | 1.0.1 | [AU PS 1.0.0 Test Suite](https://inferno.hl7.org.au/suites/au_ps_v100) |
| SMART App Launch Test Kit | 0.4.6 | 0.4.6 | [SMART App Launch STU2.2](https://inferno.hl7.org.au/suites/smart_stu2_2)<br>[SMART App Launch STU2](https://inferno.hl7.org.au/suites/smart_stu2)<br>[SMART App Launch STU1](https://inferno.hl7.org.au/suites/smart)<br>[SMART User-access Brands and Endpoints STU2.2](https://inferno.hl7.org.au/suites/smart_access_brands) |

- SMART App Launch Test Kit: hosted on purpose from v1.2.3 onwards.

The AU Core Test Kit's **FHIR Endpoint** input starts filled in with the HL7 AU reference server; change it to your own server. See [Known issues](#known-issues) before a dry run against Sparked.

## Known issues

Each issue below was last checked on the date shown.

- **The jwks_uri in SMART discovery redirects to a sign-in page** (checked Sat 21 Nov 2026). `jwks_uri` in `.well-known/smart-configuration` (`/aucore/smartauth/.well-known/jwks.json`) answers 302 to `/aucore/smartauth/signin`, so a client that follows it cannot check id_token signatures.
  _What to do:_ Use the `jwks_uri` from the OpenID configuration instead: `https://smile.sparked-fhir.com/aucore/smartauth/jwk`.
- **SMART discovery lives under the FHIR base, not under smartauth** (checked Sat 21 Nov 2026). `/aucore/smartauth/.well-known/smart-configuration` redirects to the sign-in page. Older Sparked handouts gave that address.
  _What to do:_ Use `<FHIR base>/.well-known/smart-configuration`, for example `https://smile.sparked-fhir.com/aucore/fhir/DEFAULT/.well-known/smart-configuration`.
- **An unversioned profile resolves to the ballot** (checked Sat 21 Nov 2026). On Sparked, `$validate?profile=http://hl7.org.au/fhir/core/StructureDefinition/au-core-patient` validates against 3.0.0-ballot1.
  _What to do:_ Add the version to the canonical (`...au-core-patient|2.1.0-draft`) when you want another loaded version.
- **$validate without a profile checks base FHIR only** (checked Sat 21 Nov 2026). The server does not apply AU Core profiles by default; a request without `profile` reports base FHIR R4 issues only.
  _What to do:_ Always add `?profile=<canonical>|<version>`.
- **AU Core 2.0.0 and AU Base 6.0.0 are not on Sparked** (checked Sat 21 Nov 2026). `$validate?profile=...|2.0.0` on Sparked returns "Invalid profile. Failed to retrieve profile".
  _What to do:_ Validate against AU Core 2.0.0 with the HL7 FHIR Validator (`-ig hl7.fhir.au.core#2.0.0`) or against the HL7 AU reference server.
- **$validate on fhir.hl7.org.au timed out** (checked Sat 21 Nov 2026). On 21 Nov 2026 every `$validate` request to fhir.hl7.org.au returned HTTP 504 after about a minute; reads and searches answered. That server is not run by Sparked.
  _What to do:_ Use the HL7 FHIR Validator locally with `-ig hl7.fhir.au.core#2.0.0`.
- **The first $validate after a quiet spell can time out** (checked Sat 21 Nov 2026). The first `$validate` on Sparked after an idle period has been seen to return HTTP 504 after about 15 seconds while the validator loads; the next request answers in well under a second.
  _What to do:_ Retry once.
- **$everything is not available anonymously** (checked Sat 21 Nov 2026). `GET Patient/<id>/$everything` on DEFAULT returns 403 "Access denied" without a token.
  _What to do:_ Use `Patient/<id>/$summary` (AU Patient Summary document) or searches with `patient=<id>`.
- **Resource counts are switched off** (checked Sat 21 Nov 2026). `_summary=count` and `_total=accurate` return HTTP 400 (HAPI-2038, HAPI-2037).
  _What to do:_ Page through the search results instead.
- **Binary is not served on DEFAULT** (checked Sat 21 Nov 2026). `Binary` is not an enabled resource type on the Sparked server (HAPI-0302), so the two AU Core PDF report attachments are not loaded.
  _What to do:_ Use the files in hl7au/au-fhir-test-data directly.
- **The AU Core Test Kit points at fhir.hl7.org.au by default** (checked Sat 21 Nov 2026). The kit's FHIR Endpoint input defaults to the HL7 AU reference server, not to Sparked. Four of its default ids (Location `au-hospital`, Organization `dva-au` and `organization-medical-center-tc`, PractitionerRole `cardiologist-sallie-sutherland`) are not on Sparked.
  _What to do:_ Set FHIR Endpoint to your own server. For a dry run against Sparked, use its FHIR base and remove those four ids.
- **Inferno sessions are open to anyone with the link** (checked Sat 21 Nov 2026). Session URLs need no login, results stay for about nine weeks, and resources the tests fetch from your server are kept with the session.
  _What to do:_ Point Inferno only at servers holding synthetic data, and share session links only with people you want to see the results.

## Status

There is no public status page yet. Service announcements go to the Sparked FHIR Server topic on Zulip.

## Change freeze

From Fri 4 Dec 2026, 17:00 AEDT to Fri 11 Dec 2026, 17:00 AEDT, the following stay as described here, except for a fix to an outage:

- Sparked FHIR server: no configuration changes, IG loads or test data reloads
- Inferno (inferno.hl7.org.au): no new release; the test kits stay at the versions in the Inferno section of the participant guide
- Sparked development terminology server (tx.dev.hl7.org.au): the nightly content preload is paused

## Help

- [Zulip: #australia > Sparked FHIR Server](https://chat.fhir.org/#narrow/channel/179173-australia/topic/Sparked.20FHIR.20Server): The Sparked FHIR server, sandboxes and the test data on it
- [Zulip: #australia > AU Core Track - Melbourne FHIR Connectathon #28](https://chat.fhir.org/#narrow/channel/179173-australia/topic/AU.20Core.20Track.20-.20Melbourne.20FHIR.20Connectathon.20.2328): AU Core track questions
- [Zulip: #australia > AU eRequesting Track - Melbourne FHIR Connectathon #28](https://chat.fhir.org/#narrow/channel/179173-australia/topic/AU.20eRequesting.20Track.20-.20Melbourne.20FHIR.20Connectathon.20.2328): AU eRequesting track questions, including which server the track uses
- [Zulip: #australia > AU Patient Summary Track - Melbourne FHIR Connectathon #28](https://chat.fhir.org/#narrow/channel/179173-australia/topic/AU.20Patient.20Summary.20Track.20-.20Melbourne.20FHIR.20Connectathon.20.2328): AU Patient Summary track questions
- [Zulip: #australia > SMART App Launch Track - Melbourne FHIR Connectathon #28](https://chat.fhir.org/#narrow/channel/179173-australia/topic/SMART.20App.20Launch.20Track.20-.20Melbourne.20FHIR.20Connectathon.20.2328): SMART App Launch track questions
- [Zulip: #australia > Inferno Test Kit feedback and queries](https://chat.fhir.org/#narrow/channel/179173-australia/topic/Inferno.20Test.20Kit.20feedback.20and.20queries): Inferno and the AU test kits
- [Event page (HL7 AU Confluence)](https://confluence.hl7.org/pages/viewpage.action?pageId=494872196): Agenda, tracks, venue and registration
- [Issues on this repository](https://github.com/aehrc/sparked-fhir-server-configuration/issues): A bug in the Sparked FHIR server configuration
