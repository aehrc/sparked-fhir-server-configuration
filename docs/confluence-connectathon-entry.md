# Confluence Content for Connectathon Pages

For the HL7 Australia WGM and Melbourne FHIR Connectathon (8 to 10 December 2026),
the participant guide is [`docs/participants/2026-12-melbourne.md`](participants/2026-12-melbourne.md).
On Confluence, link to it rather than copying it: it is rendered from
`events/2026-12-melbourne.yaml` and kept current for the event. The content below
is for the participant capability table row and a standing SMART page; where it
and the guide differ, the guide is right.

## 1. New Sparked Dev FHIR Server Table Entry

Add a **new row** in the participant capability table for the Sparked Dev FHIR Server (separate from the existing HL7 AU Reference Server at fhir.hl7.org.au):

**Organization/System:** Sparked Dev FHIR Server

**Contact Name:** Sparked Infrastructure Team <sparked@csiro.au>

**System Type:** Server - SMART App Host

**Server:** Yes

**Smart App Host:** Yes

**Registration required:** Not to read. Reads, searches, `$validate` and `$summary` on `DEFAULT` need no login. For a writable space with its own clients, see the sandboxes in the participant guide.

**Connection Details:**

Endpoint: https://smile.sparked-fhir.com/aucore/fhir/DEFAULT

Anonymous access (no auth): Read and search AU Core test data only. No write capability.

SMART on FHIR (with authorization): Read on the shared `DEFAULT` partition, which is read-only for participants with or without a token. Writable sandboxes for the December 2026 event are planned, not yet confirmed (go/no-go on Mon 30 Nov 2026); each comes with its own FHIR base URL, clients and login user. See the participant guide.

Participant guide: https://github.com/aehrc/sparked-fhir-server-configuration/blob/main/docs/participants/2026-12-melbourne.md

SMART Endpoints:
- Authorize: https://smile.sparked-fhir.com/aucore/smartauth/oauth/authorize
- Token: https://smile.sparked-fhir.com/aucore/smartauth/oauth/token
- Well-Known: https://smile.sparked-fhir.com/aucore/fhir/DEFAULT/.well-known/smart-configuration

Questions: the Sparked FHIR Server topic on Zulip, https://chat.fhir.org/#narrow/channel/179173-australia/topic/Sparked.20FHIR.20Server

**Additional comments:** For SMART App clients, refer to the guide: SMART App Launch using Sparked FHIR Server

---

## 2. "SMART App Launch using Sparked Dev FHIR Server" Page

Create a **new** Confluence page (separate from the existing fhir.hl7.org.au guide at https://confluence.hl7.org/spaces/HAAUCOREWG/pages/256515087).

Copy the content below into the new page:

---

# SMART App Launch using Sparked Dev FHIR Server

## Overview

The Sparked Dev FHIR Server (`smile.sparked-fhir.com`) supports SMART on FHIR for connecting third-party applications. This is a separate system from the HL7 AU Reference Server (`fhir.hl7.org.au`).

This page describes how to register your SMART App client and connect to the Sparked Dev FHIR Server. For the December 2026 Melbourne connectathon, start with the [participant guide](https://github.com/aehrc/sparked-fhir-server-configuration/blob/main/docs/participants/2026-12-melbourne.md): if the event sandboxes go ahead, each sandbox comes with its own clients and login user, and no registration below is needed.

## Key Endpoints

| Endpoint | URL |
|----------|-----|
| FHIR Base | https://smile.sparked-fhir.com/aucore/fhir/DEFAULT |
| SMART Configuration | https://smile.sparked-fhir.com/aucore/fhir/DEFAULT/.well-known/smart-configuration |
| OpenID Configuration | https://smile.sparked-fhir.com/aucore/smartauth/.well-known/openid-configuration |
| Authorize | https://smile.sparked-fhir.com/aucore/smartauth/oauth/authorize |
| Token | https://smile.sparked-fhir.com/aucore/smartauth/oauth/token |

**Note:** `fhir.hl7.org.au` is the HL7 AU official reference server (a separate system). The Sparked Dev FHIR Server uses `smile.sparked-fhir.com` for all endpoints.

## Access Modes

**Anonymous (no authentication):**
- Read and search AU Core test data
- No write capability
- No authorization required

**SMART on FHIR (with authentication):**
- Read on `DEFAULT`, which is read-only for participants with or without a token
- Write only in your own space: an event sandbox (see the participant guide), or a tenant an admin sets up on request outside events
- Requires registered SMART client
- User login and scope approval required (for SMART App Launch)

## Supported Client Types

### SMART App Launch (Public Client)

For interactive, user-facing applications (browser apps, mobile apps, EHR launch).

| Setting | Value |
|---------|-------|
| Grant Types | Authorization Code, Refresh Token |
| Client Secret | Not required (uses PKCE) |
| User Interaction | Yes - user logs in and approves scopes |
| Typical Scopes | `launch/patient patient/*.read openid fhirUser offline_access` |
| Token Lifetime | Access: 1 hour, Refresh: 24 hours |

### Backend Service (Confidential Client)

For server-to-server integration with no user interaction.

| Setting | Value |
|---------|-------|
| Grant Types | Client Credentials |
| Client Secret | Required (auto-generated during registration) |
| User Interaction | None |
| Typical Scopes | `system/*.read` or `system/*.*` |
| Token Lifetime | Access: 1 hour |

## Scopes and Permissions

SmileCDR requires both **scopes** (what the app can request) and **permissions** (what is actually allowed). Without matching permissions, FHIR requests will return HTTP 403 even with valid scopes.

### Backend Service Clients

Permissions are **automatically configured** during registration based on the requested scopes:

| Scopes | Permissions Granted |
|--------|-------------------|
| `system/*.read` | `ROLE_FHIR_CLIENT`, `FHIR_CAPABILITIES`, `FHIR_ALL_READ`, partition access (`DEFAULT`, or your tenant) |
| `system/*.*` | All of the above + `FHIR_ALL_WRITE`, `FHIR_TRANSACTION`, `FHIR_ALL_DELETE`, on your own tenant only (write scopes against `DEFAULT` are refused) |

No additional setup is needed: backend service clients are ready to use immediately after registration.

### SMART App Launch Clients

Permissions come from the **user** who logs in and authorizes the app (not the client definition). Users must have:

- `ROLE_FHIR_CLIENT`: base role for FHIR access
- `FHIR_ALL_READ`: read access to FHIR resources
- `FHIR_CAPABILITIES`: access to the CapabilityStatement
- `FHIR_ACCESS_PARTITION_NAME: DEFAULT`: access to the DEFAULT partition
- `FHIR_ALL_WRITE` (optional): write access, if needed

Connectathon user accounts will be pre-configured with appropriate permissions. Contact the Sparked team if you need a user account.

## SMART Capabilities

The server advertises the following SMART capabilities:

- `launch-ehr`
- `launch-standalone`
- `client-public`
- `client-confidential-symmetric`
- `context-ehr-patient`
- `context-ehr-encounter`
- `context-standalone-patient`
- `sso-openid-connect`
- `permission-patient`
- `permission-offline`

PKCE: `S256` is the only challenge method the discovery document advertises.

## How to Register a SMART App Client

### Option 1: GitHub Issue (Recommended)

1. Go to [SMART App Client Registration](https://github.com/aehrc/sparked-fhir-server-configuration/issues/new?template=05-smart-app-registration.yml)
2. Fill out the form:
   - **Client ID**: Unique identifier (e.g., `my-smart-app`)
   - **Client Name**: Human-readable name for your app
   - **Client Type**: SMART App Launch or Backend Service
   - **Redirect URIs**: Your app's callback URL(s), one per line
   - **Scopes**: Space-separated list of requested scopes
   - **Contact Email**: Your email address
3. Submit the issue
4. A Sparked team member will review and approve your request
5. Your client will be automatically registered and the connection details posted to your issue

### Option 2: Contact the Team

Email **sparked@csiro.au** with the following details:

- Application name
- Client ID (requested)
- Client type (SMART App Launch or Backend Service)
- Redirect URI(s)
- Required scopes
- Contact email

### Option 3: Use a Pre-configured Connectathon Client

These clients were handed out at earlier events. For the December 2026 event, clients come with a sandbox instead (see the participant guide); ask the Sparked team before relying on one of these.

| Client ID | Type | Scopes |
|-----------|------|--------|
| `connectathon-app-01` through `connectathon-app-06` | SMART App Launch (read-only) | `launch/patient patient/*.read openid fhirUser offline_access` |
| `connectathon-app-07`, `connectathon-app-08` | SMART App Launch (read+write) | `launch/patient patient/*.read patient/*.write openid fhirUser offline_access` |
| `connectathon-backend-01` | Backend Service (read-only) | `system/*.read` |
| `connectathon-backend-02` | Backend Service (read-only since 2026-07-15) | `system/*.*` |

Pre-configured SMART App Launch clients support these redirect URIs:
- `http://localhost:3000/callback`
- `http://localhost:8080/callback`
- `http://localhost:9090/callback`
- `https://inferno.healthit.gov/suites/custom/smart/redirect`

Ask the Sparked team which client ID has been assigned to you.

## Registered SMART App Clients

Clients that have been registered for the connectathon:

| Client ID | Application | Contact | Type | Scopes |
|-----------|-------------|---------|------|--------|
| `smartforms` | CSIRO Smart Forms | john.grimes@csiro.au | Backend Service | `system/*.* patient/*.* user/*.*` |

*(This table will be updated as new clients are registered)*

## What You'll Receive

When you register (or are assigned a pre-configured client), the Sparked team will provide:

**For SMART App Launch clients:**
- Client ID (e.g., `connectathon-app-03`)
- User credentials (username + password) for logging in during the authorization flow
- Endpoint URLs (or discover them via `.well-known/smart-configuration`)

**For Backend Service clients:**
- Client ID (e.g., `connectathon-backend-01`)
- Client Secret
- Endpoint URLs

No additional setup is needed on the server side: your client and user account will be pre-configured with the appropriate permissions.

## Testing Your Connection

### SMART App Launch Flow

**Prerequisites:** Your Client ID and user credentials (provided by the Sparked team).

1. Configure your app with the Client ID and endpoint URLs
2. Your app directs the user to the authorize endpoint:

```
https://smile.sparked-fhir.com/aucore/smartauth/oauth/authorize?
  response_type=code&
  client_id=YOUR_CLIENT_ID&
  redirect_uri=YOUR_REDIRECT_URI&
  scope=launch/patient%20patient/*.read%20openid%20fhirUser%20offline_access&
  state=RANDOM_STATE&
  aud=https://smile.sparked-fhir.com/aucore/fhir/DEFAULT
```

3. Log in with the username and password provided by the Sparked team
4. Approve the requested scopes
5. Your app receives an authorization code at the redirect URI
6. Exchange the code for an access token:

```bash
curl -X POST https://smile.sparked-fhir.com/aucore/smartauth/oauth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code&code=AUTH_CODE&redirect_uri=YOUR_REDIRECT_URI&client_id=YOUR_CLIENT_ID"
```

7. Use the access token to access FHIR resources:

```bash
curl -H "Authorization: Bearer ACCESS_TOKEN" \
  https://smile.sparked-fhir.com/aucore/fhir/DEFAULT/Patient
```

### Backend Service Flow

**Prerequisites:** Your Client ID and Client Secret (provided by the Sparked team).

1. Request a token using client credentials:

```bash
curl -X POST https://smile.sparked-fhir.com/aucore/smartauth/oauth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&client_id=YOUR_CLIENT_ID&client_secret=YOUR_SECRET"
```

2. Use the access token:

```bash
curl -H "Authorization: Bearer ACCESS_TOKEN" \
  https://smile.sparked-fhir.com/aucore/fhir/DEFAULT/Patient
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| HTTP 403 "Access denied" with valid token | Check that your user account has the required permissions (see Scopes and Permissions above). For Backend Service clients, permissions are set automatically; contact the Sparked team if you still get 403. |
| Token request returns HTML instead of JSON | You're hitting the login page. Use `/aucore/smartauth/oauth/token` not `/aucore/smartauth/signin` or `/aucore/smartauth/token`. |
| Scopes granted but still 403 | For SMART App Launch clients, the logged-in user needs matching permissions. For Backend Service clients, permissions are automatic; contact the Sparked team if this persists. |
| POST or PUT to `DEFAULT` returns 403 | Expected behavior. `DEFAULT` is read-only for participants, with or without a token. Write in your own sandbox or tenant. |
| Can't find the token endpoint | The correct path is `/aucore/smartauth/oauth/token` (note the `/oauth/` segment). Check the `.well-known/smart-configuration` endpoint for the canonical URLs. |

## Resources

- [SMART App Launch Specification (HL7)](https://build.fhir.org/ig/HL7/smart-app-launch/app-launch.html)
- [SmileCDR SMART on FHIR Documentation](https://smilecdr.com/docs/smart/)
- [Sparked FHIR Server Configuration (GitHub)](https://github.com/aehrc/sparked-fhir-server-configuration)
- [SMART App Registration Guide (GitHub)](https://github.com/aehrc/sparked-fhir-server-configuration/blob/main/docs/SMART-APP-REGISTRATION.md)
