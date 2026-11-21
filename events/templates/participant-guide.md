# {{ event.name }}: Sparked participant guide

{{ generated_note }}

This guide covers the services the Sparked program runs for the event: {{ sandbox.slot.services }}. For the agenda, tracks and venue, see the [event page]({{ event.event_page }}).

Everything here holds **synthetic test data only**. Never send real patient or personal data to any of these services.

## At a glance

| | |
|---|---|
| Event | {{ event.name }} ({{ event.short_name }}) |
| Dates | {{ event.dates }} |
| Venue | {{ event.venue }} |
| Sparked FHIR server | `{{ server.sparked.fhir_base }}` |
| HL7 AU reference server | `{{ server.hl7au-reference.fhir_base }}` |
| Inferno | {{ inferno.url }} |
| Sandboxes | {{ sandbox.slot.summary }} |
| Change freeze | {{ freeze.window }} |
| Help | [Sparked FHIR Server topic on Zulip]({{ help.first_url }}) |

{{ programme }}

## Endpoints

{{ servers_table }}

**Two servers share the same path.** `smile.sparked-fhir.com/aucore/fhir/DEFAULT` (Sparked) and `fhir.hl7.org.au/aucore/fhir/DEFAULT` (HL7 AU reference server) look alike but are separate systems, run by different teams, holding different IG versions. Check the host before you report a problem, and report it in the right place (see [Help](#help)).

The Sparked server's `DEFAULT` partition is read-only for participants. Reads, searches, `$validate` and `$summary` need no login. {{ sandbox.slot.writes }}

{{ other_endpoints }}

## Version map

{{ version_policy }}

{{ version_map_table }}

### Validating against a specific version

Add the profile, with its version, to `$validate`. Without `profile` the Sparked server checks base FHIR only.

```bash
curl -s -X POST \
  -H 'Content-Type: application/fhir+json' \
  --data @my-patient.json \
  '{{ server.sparked.fhir_base }}/Patient/$validate?profile={{ validate.example }}'
```

Profiles to use on each server for this event:

{{ validate_canonicals }}

## Terminology

{{ terminology_list }}

## Test data and identifiers

{{ data_section }}

Look a resource up by id or by identifier, for example:

```bash
curl -s '{{ server.sparked.fhir_base }}/Patient/hennessy-billy'
curl -s '{{ server.sparked.fhir_base }}/Patient?identifier=http://ns.electronichealth.net.au/id/hi/ihi/1.0|8003608333660645'
curl -s '{{ server.sparked.fhir_base }}/Practitioner?identifier=http://ns.electronichealth.net.au/id/hi/hpii/1.0|8003611566719005'
```

About the identifiers in this data (from the [AU test data documentation](https://github.com/hl7au/au-fhir-test-data/blob/master/docs/README.md#synthetic-data-properties)):

- **IHI, HPI-I and HPI-O** numbers come from Services Australia and are reserved for testing in the HI Vendor Test Environment.
- **Medicare card numbers, Medicare provider numbers, PBS prescriber numbers and DVA numbers** come from Services Australia but are **not reserved for testing**. Some may coincide with numbers assigned to real people. Do not use them anywhere outside a test system, and never send them to a production system or an external integration.
- **Ahpra registration numbers** carry a profession prefix (`HAC`) that is not linked to a real profession.
- **ABNs** are deliberately invalid.
- Names are fictional. Addresses are built from real address parts and may match real places.

## Sandboxes

{{ sandbox.slot.section }}

## Auth recipes

The Sparked server's discovery documents ([SMART configuration]({{ server.sparked.smart.configuration }}), [OpenID configuration]({{ server.sparked.smart.openid_configuration }})) advertise grant types `authorization_code` and `client_credentials`, confidential clients with a shared secret (`client-confidential-symmetric`) and public clients with PKCE `S256`. They list only `openid` and `fhirUser` in `scopes_supported` and advertise neither `permission-v1` nor `permission-v2`.

| | URL |
|---|---|
| SMART configuration | `<FHIR base>/.well-known/smart-configuration`, for example `{{ server.sparked.smart.configuration }}` |
| Issuer | `{{ server.sparked.smart.issuer }}` |
| Authorize | `{{ server.sparked.smart.authorize }}` |
| Token | `{{ server.sparked.smart.token }}` |
| Signing keys (JWKS) | `{{ server.sparked.smart.jwks }}` |

### No auth: read the shared data

```bash
curl -s '{{ server.sparked.fhir_base }}/Patient?_count=5'
```

{{ sandbox.slot.auth }}

### Testing your own server in Inferno: bearer token or custom header

The AU Core and AU PS test suites in Inferno take either an access token for your server (the **OAuth Credentials** input) or a custom header such as an API key (the **Header name** and **Header value** inputs). Use one or the other, and use a token or key issued for a test system holding synthetic data, because Inferno sessions are open to anyone with the link.

## Inferno

{{ inferno_section }}

## Known issues

Each issue below was last checked on the date shown.

{{ known_issues }}

## Status

{{ status_section }}

## Change freeze

{{ freeze_section }}

## Help

{{ help_list }}
