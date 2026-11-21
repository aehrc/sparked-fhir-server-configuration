<!-- slot: summary -->
{{ sandbox.url }}, with the event access code
<!-- slot: services -->
the Sparked FHIR server, writable sandboxes, the hosted Inferno test kits and the terminology servers
<!-- slot: writes -->
To write, use your own sandbox (see [Sandboxes](#sandboxes)).
<!-- slot: section -->
Writable sandboxes are **open** for this event.

{{ sandbox_details }}
<!-- slot: auth -->
The recipes that need a client use the shell variables `SANDBOX_BASE`, `CLIENT_ID` and `CLIENT_SECRET`; take their values from your sandbox page. They ask for v1-style scopes (`system/*.read`, `patient/*.read`).

### Backend services: client credentials

For a system talking to your sandbox with no user present. Send the client id and secret with HTTP Basic, then use the access token as a bearer token.

```bash
TOKEN=$(curl -s -u "$CLIENT_ID:$CLIENT_SECRET" \
  -d grant_type=client_credentials \
  -d scope='system/*.read' \
  '{{ server.sparked.smart.token }}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')
```

Ask only for the scopes your sandbox page lists for the backend client.

### Bearer token on each request

```bash
curl -s -H "Authorization: Bearer $TOKEN" "$SANDBOX_BASE/Patient?_count=5"
```

A sandbox token works on your own sandbox only. Read `DEFAULT` without a token.

### SMART App Launch with PKCE (standalone launch)

For an app that a user signs in to. Your sandbox comes with a public client and a login user; register your app's redirect URIs (https, or http on localhost) on the sandbox page first.

1. Make a PKCE verifier and its S256 challenge:

   ```bash
   CODE_VERIFIER=$(openssl rand -base64 48 | tr -d '=+/\n' | cut -c1-64)
   CODE_CHALLENGE=$(printf '%s' "$CODE_VERIFIER" | openssl dgst -sha256 -binary | openssl base64 | tr '+/' '-_' | tr -d '=\n')
   ```

2. Send the user's browser to the authorize endpoint with these query parameters (URL-encoded): `response_type=code`, `client_id`, `redirect_uri`, `scope=launch/patient openid fhirUser patient/*.read`, a random `state`, `aud=<your sandbox FHIR base>`, `code_challenge=$CODE_CHALLENGE` and `code_challenge_method=S256`.
3. The user signs in with the sandbox login user and approves. The browser comes back to your redirect URI with `code` and `state`; check that `state` matches.
4. Exchange the code:

   ```bash
   curl -s \
     -d grant_type=authorization_code \
     -d code="$CODE" \
     -d redirect_uri="$REDIRECT_URI" \
     -d client_id="$CLIENT_ID" \
     -d code_verifier="$CODE_VERIFIER" \
     '{{ server.sparked.smart.token }}'
   ```

5. The response carries `access_token`, the `patient` in context and an `id_token`. Check the `id_token` signature against `{{ server.sparked.smart.jwks }}` (see [Known issues](#known-issues) on the `jwks_uri` in SMART discovery).
