# Sparked Dev FHIR Server — Participant Handout (July Test Event)

> Shared **development** environment for the July Test Event. Synthetic / test data only —
> do **not** load real patient data or PII. Data lives in the `DEFAULT` partition, is visible
> to all participants, and may be cleared/expunged between events.

## Is the server read-only?

No — it supports both read and write, but writes require authentication:

| Access mode | What you can do |
|-------------|-----------------|
| **Anonymous** (no token) | Read + search the AU Core test data. **No writes** — an anonymous `POST`/`PUT` returns HTTP 403. |
| **SMART on FHIR** (authenticated) | Read **and** write, depending on the scopes/permissions on your client or user. This is how you POST Bundles or load your own data. |

## Endpoints (aucore node)

| | URL |
|---|---|
| FHIR Base | `https://smile.sparked-fhir.com/aucore/fhir/DEFAULT` |
| Well-Known (SMART) | `https://smile.sparked-fhir.com/aucore/smartauth/.well-known/smart-configuration` |
| Authorize | `https://smile.sparked-fhir.com/aucore/smartauth/oauth/authorize` |
| Token | `https://smile.sparked-fhir.com/aucore/smartauth/oauth/token` |

> Other nodes follow the same pattern with `/ereq/...` in place of `/aucore/...`.
> Note the `/oauth/` segment in the authorize/token paths.

## Getting a client (registration is required for writes)

You have three options:

**1. Use a pre-configured connectathon client (fastest).** Ask the Sparked team to assign one:

| Client ID | Type | Access | Scopes |
|-----------|------|--------|--------|
| `connectathon-app-01` … `06` | SMART App Launch | read-only | `launch/patient patient/*.read openid fhirUser offline_access` |
| `connectathon-app-07`, `08` | SMART App Launch | **read + write** | `… patient/*.read patient/*.write …` |
| `connectathon-backend-01` | Backend Service | read-only | `system/*.read` |
| `connectathon-backend-02` | Backend Service | **read + write** | `system/*.*` |

Pre-configured SMART App Launch clients accept these redirect URIs:
`http://localhost:3000/callback`, `http://localhost:8080/callback`, `http://localhost:9090/callback`,
`https://inferno.healthit.gov/suites/custom/smart/redirect`.

**2. Register your own client.** Open a GitHub issue with the
[SMART App Client Registration template](https://github.com/aehrc/sparked-fhir-server-configuration/issues/new?template=05-smart-app-registration.yml)
(or email `sparked@csiro.au`). Provide: client ID, name, type (SMART App Launch *or* Backend Service),
redirect URIs, scopes, contact email. You'll get your client details (and secret, for backend services) back on the issue.

**3. Backend service quick start (for loading data server-to-server):**

```bash
# Get a token
curl -X POST https://smile.sparked-fhir.com/aucore/smartauth/oauth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&client_id=YOUR_CLIENT_ID&client_secret=YOUR_SECRET"

# Use it (e.g. POST a transaction Bundle of your own synthetic data)
curl -X POST https://smile.sparked-fhir.com/aucore/fhir/DEFAULT \
  -H "Authorization: Bearer ACCESS_TOKEN" \
  -H "Content-Type: application/fhir+json" \
  --data-binary @my-bundle.json
```

## Can I bring my own synthetic dataset?

Yes — two ways:

1. **Self-load:** with a write-capable client (e.g. `connectathon-backend-02` / `system/*.*`),
   POST your own Bundles directly as shown above.
2. **Ask the team to bulk-load it:** open an
   [Operational Request](https://github.com/aehrc/sparked-fhir-server-configuration/issues/new?template=03-operational-request.yml)
   and point to your data source — an attached Bundle, an S3 path, a Synthea config, or a URL.
   The team loads it via the `sparked-test-data-loader`. Data aligned to AU Core profiles is expected.

You're not restricted to the provided test data — bring datasets aligned to your own use cases.

## Common gotchas

- **Anonymous POST → 403.** Expected. Authenticate for writes.
- **403 with a valid token.** For SMART App Launch, permissions come from the *logged-in user* (needs `FHIR_ALL_WRITE` for writes); for backend services they come from the client's scopes. Contact the Sparked team if a backend client still 403s.
- **Token request returns HTML.** You hit the login page — use `/aucore/smartauth/oauth/token` (with `/oauth/`), not `/signin`.

## Questions

GitHub issues on `aehrc/sparked-fhir-server-configuration`, or email `sparked@csiro.au`.
