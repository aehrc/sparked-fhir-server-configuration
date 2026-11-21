<!-- slot: summary -->
On request from the Sparked team, by Zulip direct message; see [Sandboxes](#sandboxes)
<!-- slot: services -->
the Sparked FHIR server, writable sandboxes issued on request, the hosted Inferno test kits and the terminology servers
<!-- slot: writes -->
To write, ask the Sparked team for a sandbox of your own (see [Sandboxes](#sandboxes)).
<!-- slot: section -->
Writable sandboxes for this event are issued **on request** by the Sparked team. A sandbox is your own writable space on the Sparked FHIR server, with its own FHIR base URL, clients and starter data, separate from every other participant's.

**Getting one.** From {{ sandbox.opens }} until {{ sandbox.creation_closes }}, ask in the Sparked FHIR Server topic on Zulip (see [Help](#help)) or at the Sparked desk at the venue. The Sparked team sends you your sandbox's credentials by Zulip direct message, from a batch made ready before the event. There is no web page to visit and nothing to sign up for. Keep the credentials to yourself and never post them in a Zulip channel.

**What you get**, all in that direct message:

- a FHIR base URL for your sandbox on `smile.sparked-fhir.com` (`fhir_base`), with its token and authorize URLs
- a backend services client (`backend_client_id` and `backend_client_secret`)
- a login user (`app_username` and `app_password`) and a public PKCE client for SMART App Launch (`app_client_id`)
- AU Core starter data, with resource ids prefixed by your sandbox id

**Redirect URIs for SMART App Launch.** Give the Sparked team your app's redirect URIs (https, or http on localhost) when you ask, and your sandbox is issued with them. If you need them, or different ones, later, you get a new sandbox with them: a new FHIR base URL, new credentials and fresh starter data. Your old sandbox is expired once you have moved over.

**On request.** Ask in the same direct message conversation to have your sandbox reset (cleared and the starter data reloaded) or for a new backend client secret.

**Dates.** Sandboxes for this event expire {{ sandbox.expires }}; their clients and login users are disabled and their data is deleted then.

**Limits.** Up to {{ sandbox.resource_ceiling }} resources in one sandbox, and at most {{ sandbox.max_live }} sandboxes live at once for the event. Synthetic data only: the Sparked team can see everything in every sandbox.
<!-- slot: auth -->
The recipes that need a client use the shell variables `SANDBOX_BASE`, `CLIENT_ID` and `CLIENT_SECRET` (the backend services client) and `APP_CLIENT_ID` (the public App Launch client). Take their values from the credentials the Sparked team sent you: `fhir_base`, `backend_client_id`, `backend_client_secret` and `app_client_id`. The recipes ask for v1-style scopes (`system/*.read`, `patient/*.read`). The App Launch recipe needs a sandbox issued with your app's redirect URIs (see [Sandboxes](#sandboxes)).

{{ sandbox_recipes }}
