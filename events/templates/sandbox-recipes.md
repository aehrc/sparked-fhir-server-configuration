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

### SMART App Launch in a sandbox

Works:
- Standalone launch. Your sandbox's login user signs in; the patient in context is your sandbox's `Patient/<id>-hennessy-billy`, and the token's patient is the bare id `<id>-hennessy-billy`.
- EHR launch from your sandbox page. Open "EHR launch" on an App Launch client that holds the `launch` scope, choose a starter patient and practitioner, and follow the link: your app gets `iss` (your sandbox's FHIR base) and `launch`. The launch URL must be on the same host and port as one of that client's redirect URIs.
- SMART v1 and v2 scopes. App Launch clients hold `patient/*.cruds` and `user/*.cruds` besides the v1 scopes, so an app may ask for any part of one, for example `patient/*.rs`, `patient/Observation.rs` or `patient/AllergyIntolerance.cus`. Each scope you ask for must fit inside one scope the client holds.
- `fhirUser` names a starter practitioner: `Practitioner/<id>-armstrong-amada` after a standalone launch, or the one you pick for an EHR launch.
- Every launch issues a fresh token, with the patient of that launch.
- An EHR launch may ask for `launch` with `launch/patient` or `launch/encounter`: the token carries the launch's patient and encounter, and its granted scope lists `launch` without them.
- `offline_access`: an app that asks for it gets a refresh token that lasts 8 hours.

Does not work:
- Choosing a patient during a standalone launch: there is no patient picker. Use EHR launch from your sandbox page instead.
- `private_key_jwt`: confidential clients use a client secret only.
- Keeping an app to one patient: a `patient/` scope reaches every patient in your sandbox, not only the launch patient.

Need an EHR to launch from, or a feature the sandbox lacks? See the hosts on the [SMART App Launch track page](https://confluence.hl7.org/pages/viewpage.action?pageId=506662031).
