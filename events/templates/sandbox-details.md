A sandbox is your own writable space on the Sparked FHIR server, with its own FHIR base URL, clients and starter data, separate from every other participant's.

**Getting one.** Go to {{ sandbox.url }} and enter the event access code. From {{ sandbox.opens }}, the code is {{ sandbox.access_code_distribution }}. There is no account to create and no GitHub login.

{{ sandbox.access_code_line }}

**What you get**, all shown on your sandbox page:

- a FHIR base URL for your sandbox on `smile.sparked-fhir.com`
- a backend services client (client id and secret; the secret is shown once, and you can rotate it)
- a login user and a public PKCE client for SMART App Launch, with the redirect URIs you enter
- AU Core starter data, with resource ids prefixed by your sandbox id
- a **Reset** button that clears your sandbox and reloads the starter data

**Dates.** Sandboxes can be created from {{ sandbox.opens }} until {{ sandbox.creation_closes }}. Sandboxes for this event expire {{ sandbox.expires }}; their clients and login users are disabled and their data is deleted then.

**Limits.** Up to {{ sandbox.resource_ceiling }} resources in one sandbox, and at most {{ sandbox.max_live }} sandboxes live at once for the event. One network address can create up to {{ sandbox.pre_event.creates_per_ip_per_day }} sandboxes a day until {{ sandbox.pre_event_until }}, and up to {{ sandbox.creates_per_ip_per_day }} a day from then (the venue Wi-Fi puts everyone behind one address). Synthetic data only: the Sparked team can see everything in every sandbox.
