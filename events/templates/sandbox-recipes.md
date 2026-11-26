### Backend services: client credentials

For a system talking to your sandbox with no user present. Send the client id and secret with HTTP Basic, then use the access token as a bearer token.

```bash
TOKEN=$(curl -s -u "$CLIENT_ID:$CLIENT_SECRET" \
  -d grant_type=client_credentials \
  -d scope='system/*.read' \
  '{{ server.sparked.smart.token }}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')
```

### Bearer token on each request

```bash
curl -s -H "Authorization: Bearer $TOKEN" "$SANDBOX_BASE/Patient?_count=5"
```

A sandbox token works on your own sandbox only. Read `DEFAULT` without a token.

### SMART App Launch with PKCE (standalone launch)

For an app that a user signs in to. Your sandbox comes with a public client and a login user. The `redirect_uri` must be one registered on that client (https, or http on localhost).

1. Make a PKCE verifier and its S256 challenge:

   ```bash
   CODE_VERIFIER=$(openssl rand -base64 48 | tr -d '=+/\n' | cut -c1-64)
   CODE_CHALLENGE=$(printf '%s' "$CODE_VERIFIER" | openssl dgst -sha256 -binary | openssl base64 | tr '+/' '-_' | tr -d '=\n')
   ```

2. Send the user's browser to the authorize endpoint with these query parameters (URL-encoded): `response_type=code`, `client_id=$APP_CLIENT_ID`, `redirect_uri`, `scope=launch/patient openid fhirUser patient/*.read`, a random `state`, `aud=<your sandbox FHIR base>`, `code_challenge=$CODE_CHALLENGE` and `code_challenge_method=S256`.
3. The user signs in with the sandbox login user and approves. The browser comes back to your redirect URI with `code` and `state`; check that `state` matches.
4. Exchange the code:

   ```bash
   curl -s \
     -d grant_type=authorization_code \
     -d code="$CODE" \
     -d redirect_uri="$REDIRECT_URI" \
     -d client_id="$APP_CLIENT_ID" \
     -d code_verifier="$CODE_VERIFIER" \
     '{{ server.sparked.smart.token }}'
   ```

5. The response carries `access_token`, the `patient` in context and an `id_token`. Check the `id_token` signature against `{{ server.sparked.smart.jwks }}`.
