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
The recipes that need a client use the shell variables `SANDBOX_BASE`, `CLIENT_ID` and `CLIENT_SECRET` (the backend services client) and `APP_CLIENT_ID` (the public App Launch client); take their values from your sandbox page. They ask for v1-style scopes (`system/*.read`, `patient/*.read`); ask only for the scopes your sandbox page lists for each client. Register your app's redirect URIs on the sandbox page before the App Launch recipe.

{{ sandbox_recipes }}
