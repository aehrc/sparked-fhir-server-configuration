# SMART App Registration Guide

Complete guide to registering SMART on FHIR / OIDC clients on the Sparked FHIR Server (SmileCDR).

## Key Endpoints

| Endpoint | URL |
|----------|-----|
| FHIR Base | `https://smile.sparked-fhir.com/aucore/fhir/DEFAULT` |
| Well-Known (OIDC) | `https://smile.sparked-fhir.com/aucore/smartauth/.well-known/openid-configuration` |
| SMART Configuration | `https://smile.sparked-fhir.com/aucore/smartauth/.well-known/smart-configuration` |
| Authorize | `https://smile.sparked-fhir.com/aucore/smartauth/authorize` |
| Token | `https://smile.sparked-fhir.com/aucore/smartauth/oauth/token` |
| Login Page | `https://smile.sparked-fhir.com/aucore/smartauth/signin` |
| Admin Console | `https://smile.sparked-fhir.com/aucore/console` |

> **Note**: SMART auth is only configured on the **aucore** node. The hl7au and ereq nodes do not have SMART auth modules.

## Client Types

### SMART App Launch (Public Client)

For interactive, user-facing applications (browser apps, mobile apps, EHR launch).

- **Grant Types**: Authorization Code + Refresh Token
- **Secret**: Not required (uses PKCE for security)
- **User Interaction**: Yes - user logs in and approves scopes
- **Typical Scopes**: `launch/patient patient/*.read openid fhirUser offline_access`
- **Token Lifetime**: Access token 1 hour, refresh token 24 hours

### Backend Service (Confidential Client)

For server-to-server integration with no user interaction.

- **Grant Types**: Client Credentials
- **Secret**: Required (auto-generated, 32 characters)
- **User Interaction**: None
- **Typical Scopes**: `system/*.read` or `system/*.*`
- **Token Lifetime**: Access token 1 hour

### Comparison

| Feature | SMART App Launch | Backend Service |
|---------|-----------------|-----------------|
| Grant Type | AUTHORIZATION_CODE + REFRESH_TOKEN | CLIENT_CREDENTIALS |
| Secret Required | No (PKCE) | Yes |
| User Interaction | Yes (login + consent) | No |
| Redirect URIs | Required | Not needed |
| Access Token TTL | 3600s | 3600s |
| Refresh Token TTL | 86400s | N/A |
| Use Case | Patient/clinician-facing apps | Automated pipelines, bulk data |

## Registration Methods

### Method 1: Via GitHub Issue (Recommended)

Best for: Connectathon participants, external developers

1. Go to [Issues > New Issue](../../issues/new/choose)
2. Select **"SMART App Client Registration"**
3. Fill out the form:
   - **Client ID**: Unique identifier (e.g., `my-smart-app`)
   - **Client Name**: Human-readable name
   - **Client Type**: SMART App Launch or Backend Service
   - **Redirect URIs**: Your app's callback URLs (one per line)
   - **Scopes**: Space-separated scopes
   - **Contact Email**: Your email
4. Submit the issue
5. Wait for admin review and `ready-for-automation` label
6. Automation registers the client and posts details to your issue (~1 minute)

### Method 2: Via Script (CLI)

Best for: Admins, automated deployments, bulk registration

```bash
# Set credentials
export CSIRO_FHIR_AUTH_64="your_base64_credentials"

# Register a SMART App Launch client
python scripts/register_smart_client.py \
  --client-type smart-app-launch \
  --client-id my-app \
  --client-name "My SMART App" \
  --redirect-uris "https://app.example.com/callback,http://localhost:3000/callback" \
  --scopes "launch/patient patient/*.read openid fhirUser offline_access"

# Register a Backend Service client
python scripts/register_smart_client.py \
  --client-type backend-service \
  --client-id my-backend \
  --client-name "My Backend Service" \
  --scopes "system/*.*"

# Bulk register connectathon clients
python scripts/register_smart_client.py \
  --bulk --clients-file module-config/connectathon-clients.json

# Dry run (preview only)
python scripts/register_smart_client.py \
  --bulk --clients-file module-config/connectathon-clients.json --dry-run
```

### Method 3: Via Admin Console (Manual)

Best for: One-off registrations, troubleshooting

1. Go to the [SmileCDR Admin Console](https://smile.sparked-fhir.com/aucore/console)
2. Navigate to **Users & Authorization** > **OpenID Connect Clients**
3. Click **Add Client**
4. Fill out:
   - **Client ID**: Unique identifier
   - **Client Name**: Display name
   - **Authorization Grant Types**: Select `Authorization Code` + `Refresh Token` (for SMART apps) or `Client Credentials` (for backend services)
   - **Authorized Redirect URLs**: Your callback URLs
   - **SMART Scopes > Scopes**: Space-separated scope list
   - **Remember User Approved Scopes**: Yes
5. Click **Create Client**

## Connectathon Quick Start

For connectathon events, pre-configured clients are available for quick distribution.

### Option A: Bulk Register via GitHub Actions

1. Go to **Actions** > **Register SMART Clients** > **Run workflow**
2. Select mode: `bulk-connectathon`
3. Enable **Dry Run** first to preview
4. Run again with dry run disabled to register all 10 clients
5. Distribute client IDs to participants:
   - `connectathon-app-01` through `connectathon-app-08` (SMART App Launch, read-only)
   - `connectathon-backend-01`, `connectathon-backend-02` (Backend Service)

### Option B: Register via CLI

```bash
# Preview first
python scripts/register_smart_client.py \
  --bulk --clients-file module-config/connectathon-clients.json --dry-run

# Register all
python scripts/register_smart_client.py \
  --bulk --clients-file module-config/connectathon-clients.json
```

### Pre-configured Client Details

All SMART App Launch connectathon clients come with:
- **Scopes**: `launch/patient patient/*.read openid fhirUser offline_access`
- **Redirect URIs**: `http://localhost:3000/callback`, `http://localhost:8080/callback`, `http://localhost:9090/callback`, `https://inferno.healthit.gov/suites/custom/smart/redirect`

Participants who need custom redirect URIs or scopes should request a dedicated client via the issue template.

### Participant Handout

Share this with connectathon participants:

```
Sparked FHIR Server - SMART on FHIR Connection Details
=======================================================

FHIR Base URL:     https://smile.sparked-fhir.com/aucore/fhir/DEFAULT
Authorize URL:     https://smile.sparked-fhir.com/aucore/smartauth/authorize
Token URL:         https://smile.sparked-fhir.com/aucore/smartauth/oauth/token
Well-Known:        https://smile.sparked-fhir.com/aucore/smartauth/.well-known/openid-configuration

Your Client ID:    connectathon-app-XX  (assigned to you)
Client Secret:     Not needed (public client with PKCE)
Scopes:            launch/patient patient/*.read openid fhirUser offline_access

Need a custom client? Create a GitHub issue:
https://github.com/aehrc/sparked-fhir-server-configuration/issues/new/choose
```

## Important Notes

### Scopes AND Permissions

Registering a client with scopes is only half the equation. The client also needs matching **permissions** in SmileCDR. Without permissions, scope-based access will be denied (HTTP 403) even if scopes are granted during authorization.

> **API note:** The SmileCDR Admin JSON API uses the field name `permissions` (not `grantedAuthorities`) for OIDC client permission definitions.

**Backend Service clients**: The registration script **automatically maps scopes to permissions**. For example:
- `system/*.read` → `ROLE_FHIR_CLIENT` + `FHIR_ALL_READ` + `FHIR_CAPABILITIES` + partition access
- `system/*.*` → All of the above + `FHIR_ALL_WRITE` + `FHIR_TRANSACTION`

**SMART App Launch clients**: Permissions come from the **user** who logs in and authorizes the app (not the client definition). Users need appropriate roles:
- `ROLE_FHIR_CLIENT` — base role for FHIR access
- `FHIR_ALL_READ` — read access to FHIR resources
- `FHIR_ALL_WRITE` — write access (if needed)
- `FHIR_ACCESS_PARTITION_NAME` with argument `DEFAULT` — access to the DEFAULT partition

### OpenID Connect Security Must Be Enabled

The FHIR endpoint must have **OpenID Connect Security** enabled in its configuration:
- Configuration > fhir_endpoint > Auth: OpenID Connect > **OpenID Connect Security: Yes**
- The dependency must be set to: **smart_auth (SMART Outbound Security)**

If this is disabled, OAuth tokens will be silently ignored and requests will fall through to anonymous access.

### Correct Endpoint Paths

Common mistakes with endpoint URLs:

| Wrong | Correct |
|-------|---------|
| `/aucore/smartauth/token` | `/aucore/smartauth/oauth/token` |
| `/aucore/oauth/token` | `/aucore/smartauth/oauth/token` |
| `/aucore/smart/token` | `/aucore/smartauth/oauth/token` |

The `/aucore/smartauth/signin` path is the **interactive login page**, not the API token endpoint.

### JWKS Configuration

The SMART auth module requires a properly configured JWKS (JSON Web Key Set) for signing tokens. The server uses:
- **Keystore ID**: `smilecdr-token-signing`
- **Algorithm**: RS256

If you see "Signing JSON Web KeySet (JWKS) is using the example keystore" in the admin console, the JWKS needs to be reconfigured before clients can be created.

## Troubleshooting

**HTTP 403 "Access denied" when using a valid token:**
- Check that OpenID Connect Security is enabled on the FHIR endpoint
- Verify the user/client has appropriate permissions (not just scopes)
- Ensure the token hasn't expired (`expires_in` field in token response)

**HTTP 403 "Forbidden" when requesting a token:**
- You may be hitting the wrong endpoint path (see correct paths above)
- Verify the client exists and is enabled

**Token request returns HTML instead of JSON:**
- You're hitting the login page, not the API endpoint
- Use `/aucore/smartauth/oauth/token` not `/aucore/smartauth/signin`

**Client creation fails in admin console:**
- Ensure the JWKS is properly configured (not using example keystore)
- Check the smart_auth module is running

**"No OpenID Connect modules configured":**
- The SMART Outbound Security module needs to be started on the aucore node
- Check Runtime > Modules in the admin console

## Admin Operations Cheat Sheet

All commands below require:

```bash
export CSIRO_FHIR_AUTH_64="your_base64_credentials"
```

### Connectathon Setup (Full)

Run these in order to prepare for a connectathon:

```bash
# 1. Register all pre-configured clients (or skip existing)
python scripts/register_smart_client.py \
  --bulk --clients-file module-config/connectathon-clients.json

# 2. Update existing clients with correct permissions (if created before permissions were added)
python scripts/register_smart_client.py \
  --bulk --clients-file module-config/connectathon-clients.json \
  --update-existing

# 3. Create user accounts for SMART App Launch participants
python scripts/manage_smart_users.py \
  --bulk --users-file module-config/connectathon-users.json
```

### Register a Single Client

```bash
# SMART App Launch (public, no secret)
python scripts/register_smart_client.py \
  --client-type smart-app-launch \
  --client-id my-app \
  --client-name "My SMART App" \
  --redirect-uris "https://app.example.com/callback,http://localhost:3000/callback" \
  --scopes "launch/patient patient/*.read openid fhirUser offline_access"

# Backend Service (confidential, secret auto-generated)
python scripts/register_smart_client.py \
  --client-type backend-service \
  --client-id my-backend \
  --client-name "My Backend Service" \
  --scopes "system/*.*"
```

### Create a Single User

```bash
# Read-only user with practitioner launch context
python scripts/manage_smart_users.py \
  --username test-user \
  --given-name Test \
  --family-name User \
  --permissions read-only \
  --practitioner-id guthrie-aaron

# Read-write user
python scripts/manage_smart_users.py \
  --username test-writer \
  --given-name Test \
  --family-name Writer \
  --permissions read-write \
  --practitioner-id guthrie-aaron
```

> **Note:** Passwords are auto-generated and printed to the console. They cannot be retrieved after creation.

### Update Existing Client Permissions

Use `--update-existing` to patch permissions onto clients that were created before permission mapping was added (or created manually via the admin console):

```bash
# Dry run first to preview changes
python scripts/register_smart_client.py \
  --bulk --clients-file module-config/connectathon-clients.json \
  --update-existing --dry-run

# Apply updates
python scripts/register_smart_client.py \
  --bulk --clients-file module-config/connectathon-clients.json \
  --update-existing
```

This will:
- **Backend Service clients**: Set `ROLE_FHIR_CLIENT`, `FHIR_CAPABILITIES`, `FHIR_ALL_READ`, partition access, and optionally `FHIR_ALL_WRITE` + `FHIR_TRANSACTION` (based on scopes)
- **SMART App Launch clients**: Set `FHIR_ACCESS_PARTITION_NAME: DEFAULT` (partition access)
- Existing permissions are preserved (merge, not replace)

### Verify a Client's Permissions

```bash
# Check what permissions a client has
curl -s -H "Authorization: Basic $CSIRO_FHIR_AUTH_64" \
  -H "Content-Type: application/json" \
  "https://smile.sparked-fhir.com/aucore/admin-json/openid-connect-clients/aucore/smart_auth/CLIENT_ID" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('Scopes:', d.get('scopes')); print('Permissions:', json.dumps(d.get('permissions',[]), indent=2))"
```

### Test the Token Endpoint

```bash
# Backend Service: get a token
curl -X POST https://smile.sparked-fhir.com/aucore/smartauth/oauth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&client_id=CLIENT_ID&client_secret=CLIENT_SECRET"

# Use the token
curl -H "Authorization: Bearer ACCESS_TOKEN" \
  https://smile.sparked-fhir.com/aucore/fhir/DEFAULT/Patient?_count=1
```

### Verify SMART Auth Is Working

```bash
# Check well-known endpoint
curl -s https://smile.sparked-fhir.com/aucore/smartauth/.well-known/openid-configuration | python3 -m json.tool

# Check SMART configuration
curl -s https://smile.sparked-fhir.com/aucore/smartauth/.well-known/smart-configuration | python3 -m json.tool
```

---

## How SMART Auth Works

### Architecture

The aucore node has two key modules for SMART auth:

| Module | Type | Role |
|--------|------|------|
| `smart_auth` | SMART Outbound Security | Issues OAuth2/OIDC tokens, handles authorization flows |
| `security_in_smart` | Security Inbound SMART | Validates tokens on incoming FHIR requests, manages users |

### Token Flow: SMART App Launch (Public Client)

```
User's App                SmileCDR smart_auth              SmileCDR FHIR
    │                          │                               │
    │──GET /authorize──────────▶                               │
    │◀─────Login page──────────│                               │
    │──POST credentials────────▶                               │
    │◀─────Scope approval──────│                               │
    │──Approve scopes──────────▶                               │
    │◀─────302 redirect + code─│                               │
    │──POST /oauth/token───────▶                               │
    │  (authorization_code)    │                               │
    │◀─────access_token────────│                               │
    │──GET /fhir/Patient───────┼───(validates token)───────────▶
    │◀─────FHIR response───────┼───────────────────────────────│
```

**Permissions come from the user** who logs in. The client definition only needs scopes and redirect URIs.

### Token Flow: Backend Service (Confidential Client)

```
Server App                 SmileCDR smart_auth              SmileCDR FHIR
    │                          │                               │
    │──POST /oauth/token───────▶                               │
    │  (client_credentials +   │                               │
    │   client_id + secret)    │                               │
    │◀─────access_token────────│                               │
    │──GET /fhir/Patient───────┼───(validates token)───────────▶
    │◀─────FHIR response───────┼───────────────────────────────│
```

**Permissions come from the client definition** (`permissions` field). There is no user involved.

### Permission Mapping

The registration script automatically maps scopes to permissions for backend service clients:

| Scopes | Permissions Set |
|--------|----------------|
| `system/*.read` | `ROLE_FHIR_CLIENT`, `FHIR_CAPABILITIES`, `FHIR_ACCESS_PARTITION_NAME: DEFAULT`, `FHIR_ALL_READ` |
| `system/*.*` | All of the above + `FHIR_ALL_WRITE`, `FHIR_TRANSACTION` |

For SMART App Launch clients, the script sets `FHIR_ACCESS_PARTITION_NAME: DEFAULT` on the client. All other permissions come from the user account.

### SmileCDR Module Configuration

| Setting | Value |
|---------|-------|
| Issuer URL | `https://smile.sparked-fhir.com/aucore/smartauth` |
| Context Path | `/aucore/smartauth/` |
| CORS Enabled | Yes |
| PKCE Required | No (recommended but not enforced) |
| PKCE Plain Challenge Supported | Yes |
| Signing Algorithm | RS256 |
| Auth Request Whitelist | `aud,grant_type,scope,launch` |

### Admin Console: Adding a User Manually

If you need to create a user via the admin console instead of the script:

1. Go to **Users & Authorization** > **User Management**
2. Select the module for the aucore node (`security_in_smart`)
3. Click **Add User**
4. Enter **Username**, **Password**, **Given Name**, **Family Name**
5. Under **Default Launch Contexts**, add **Practitioner** with the ID of an existing Practitioner resource (e.g., `guthrie-aaron`)
6. Under **Roles and Permissions**:
   - Set **FHIR Client** to Yes
   - Enable: **FHIR Read (All)**, **FHIR Access Server Capability Statement**
   - Add **Access data in Partition** with argument `DEFAULT`
   - Optionally enable: **FHIR Write (All)**, **FHIR Transaction** (for write access)
7. Click **Create User**

---

## Reference

- [SmileCDR SMART on FHIR Documentation](https://smilecdr.com/docs/smart/)
- [SmileCDR Client Definitions](https://smilecdr.com/docs/smart/client_management.html)
- [SmileCDR OpenID Connect Clients API](https://smilecdr.com/docs/json_admin_endpoints/openid_connect_clients_endpoint.html)
- [SMART App Launch Specification](https://build.fhir.org/ig/HL7/smart-app-launch/app-launch.html)
- [Sparked SMART App Client Configuration (Confluence)](https://confluence.hl7.org/spaces/HAFWG/pages/256515294/Sparked+SMART+App+Client+Configuration)
