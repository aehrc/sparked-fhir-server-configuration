A sandbox is your own writable space on the Sparked FHIR server, with its own FHIR base URL, clients and starter data, separate from every other participant's.

**Getting one.** Go to {{ sandbox.url }} and enter the event access code. The code is {{ sandbox.access_code_distribution }}; it is not published online. There is no account to create and no GitHub login during the event.

{{ sandbox.access_code_line }}

**What you get**, all shown on your sandbox page:

- a FHIR base URL for your sandbox on `smile.sparked-fhir.com`
- a backend services client (client id and secret; the secret is shown once, and you can rotate it)
- a login user and a public PKCE client for SMART App Launch, with the redirect URIs you enter
- AU Core starter data, with resource ids prefixed by your sandbox id
- a **Reset** button that clears your sandbox and reloads the starter data

**Dates.** Sandboxes can be created from {{ sandbox.opens }} until {{ sandbox.creation_closes }}. Every sandbox for this event expires on {{ sandbox.expires }}; its clients and login user are disabled and its data is deleted.

**Limits.** Up to {{ sandbox.max_resources }} resources in one sandbox, and {{ sandbox.max_live }} sandboxes in total for the event. Synthetic data only: the Sparked team can see everything in every sandbox.
