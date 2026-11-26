/**
 * SMART Post-Authorization Callback Script
 *
 * Called just prior to issuing a new access token. Handles two cases:
 *
 * 1. EHR Launch (launch token present): decodes the base64 launch parameter,
 *    injects patient/encounter context into the token, and sets fhirUser to
 *    the Practitioner from the launch token (or falls back to the user's
 *    default launch contexts, as in 2).
 *
 * 2. Standalone Launch (no launch token): sets fhirUser from the user's
 *    default "practitioner" launch context or, for a sandbox login without
 *    one, from its "sbx-fhiruser" context (defaultFhirUser below).
 *
 * It also offers a patient picker on standalone launches through sandbox
 * clients only (onSmartLoginPreContextSelection below).
 *
 * By default SmileCDR sets fhirUser to an auto-generated RelatedPerson.
 * This script overrides that with the correct Practitioner (or, for a
 * sandbox login, the Patient its sbx-fhiruser context names) in both flows.
 *
 * Config key: post_authorize_script.file (SMART Outbound Security module)
 * Docs: https://smilecdr.com/docs/smart/user_profile.html
 */

// Fallback audience when neither getAudience() nor the whitelisted "aud"
// request parameter yields a value (some standalone launches). This base is
// node-specific: scripts/sync_smart_auth.py rewrites the node segment when
// pushing this script to each node, so keep the URL on a single line.
var DEFAULT_AUDIENCE_BASE = "https://smile.sparked-fhir.com/aucore/fhir/DEFAULT";

/** Read a bean property, trying the property form first and then its getter. */
function beanProperty(theObject, theName, theGetter) {
    var value = theObject[theName];
    if ((value === null || value === undefined) && typeof theObject[theGetter] === "function") {
        value = theObject[theGetter]();
    }
    return value;
}

/**
 * The ways to reach the user's approved scopes, in the order they are tried.
 * Smile CDR hands the script Java objects: on its GraalJS engine the approved
 * scopes are a java.util.Set<String> (UserSessionDetailsJson.getApprovedScopes(),
 * never null), which has none of the JS array methods (indexOf, includes,
 * length), so it is only ever asked through its own Java methods.
 */
var APPROVED_SCOPE_READS = [
    { name: "getApprovedScopes()", read: function (theUserSession) { return theUserSession.getApprovedScopes(); } },
    { name: "approvedScopes", read: function (theUserSession) { return theUserSession.approvedScopes; } }
];

/** Whether a Java collection reports size() 0; false when that cannot be read. */
function isEmptySet(theSet) {
    try {
        return Number(theSet.size()) === 0;
    } catch (e) {
        return false;
    }
}

/**
 * Whether theScope is among the user's approved scopes: true or false, or null
 * (unknown) when no read works. Each read is tried on its own, so one failing
 * does not hide the other; a read counts only when contains() answers with a
 * boolean. An empty set counts as unknown, as before: an approved login always
 * has at least one scope, so empty means "not populated at this point".
 */
function granted(theUserSession, theScope) {
    for (var i = 0; i < APPROVED_SCOPE_READS.length; i++) {
        try {
            var scopes = APPROVED_SCOPE_READS[i].read(theUserSession);
            var answer = scopes.contains(theScope);
            if (typeof answer === "boolean") {
                return answer || !isEmptySet(scopes) ? answer : null;
            }
        } catch (e) {
            // Try the next read.
        }
    }
    return null;
}

/**
 * The whitelisted "scope" parameter of the original /authorize request (what
 * the app asked for, not what was granted) as a string, or null when it is
 * absent or cannot be read. getRequestParameters() is a Java Map<String,String>.
 */
function requestedScopeString(theAuthorizationRequestDetails) {
    try {
        var value = theAuthorizationRequestDetails.getRequestParameters().get("scope");
        return value === null || value === undefined ? null : String(value);
    } catch (e) {
        return null;
    }
}

/** The requested scope string split on whitespace, or null when it is unreadable or empty. */
function requestedScopesOf(theAuthorizationRequestDetails) {
    var value = requestedScopeString(theAuthorizationRequestDetails);
    if (value === null) {
        return null;
    }
    var parts = value.split(/\s+/);
    var out = [];
    for (var i = 0; i < parts.length; i++) {
        if (parts[i]) {
            out.push(parts[i]);
        }
    }
    return out.length > 0 ? out : null;
}

/**
 * Whether Smile CDR puts the launch/<key> claim into this token itself, so the
 * script must not add it again. Neither scope source alone is trusted to equal
 * the token's grant: the approved scopes may carry approvals remembered from an
 * earlier consent, and the request parameter names scopes the user may have
 * declined. So the claim is skipped only when "launch/" + key is granted and,
 * when the request's scope parameter is readable, requested as well. When the
 * approved scopes are unknown, the request parameter decides alone; when
 * neither is readable, the claim is added (the behaviour before the skip).
 */
function smileAddsLaunchClaim(theKey, theUserSession, theRequestedScopes) {
    var scope = "launch/" + theKey;
    var isGranted = granted(theUserSession, scope);
    var isRequested = theRequestedScopes ? theRequestedScopes.indexOf(scope) >= 0 : null;
    if (isGranted !== null) {
        return isGranted && isRequested !== false;
    }
    if (isRequested !== null) {
        return isRequested;
    }
    return false;
}

/**
 * Whether the login is through a sandbox client, whose id starts with "sbx-"
 * (aehrc/sparked-sandbox registers them as sbx-<id>-<kind>). Never throws.
 */
function isSandboxClient(theUserSession) {
    var reads = [
        function () { return theUserSession.getOidcClientId(); },
        function () { return theUserSession.oidcClientId; }
    ];
    for (var i = 0; i < reads.length; i++) {
        try {
            var clientId = reads[i]();
            if (clientId !== null && clientId !== undefined) {
                return String(clientId).indexOf("sbx-") === 0;
            }
        } catch (e) {
            // Try the next read.
        }
    }
    return false;
}

/**
 * One line describing how the approved scopes were read: which read worked,
 * the set's size() and toString(), or why each read failed. Scope names only.
 */
function approvedScopesDiagnostic(theUserSession) {
    var failed = [];
    for (var i = 0; i < APPROVED_SCOPE_READS.length; i++) {
        var name = APPROVED_SCOPE_READS[i].name;
        try {
            var scopes = APPROVED_SCOPE_READS[i].read(theUserSession);
            var answer = scopes.contains("launch");
            if (typeof answer !== "boolean") {
                failed.push(name + " contains() gave " + typeof answer);
                continue;
            }
            var size;
            var text;
            try { size = scopes.size(); } catch (e) { size = "unreadable (" + e + ")"; }
            try { text = String(scopes.toString()); } catch (e) { text = "unreadable (" + e + ")"; }
            return "approved read=" + name + " size=" + size + " scopes=" + text;
        } catch (e) {
            failed.push(name + " threw " + e);
        }
    }
    return "approved read=none (" + failed.join("; ") + ")";
}

/** Log one diagnostic line for a sandbox login. Never throws. */
function logSandboxScopes(theWhere, theUserSession, theRequested, theOutcome) {
    try {
        Log.info("Sandbox scopes at " + theWhere + ": " + approvedScopesDiagnostic(theUserSession) +
            "; requested=" + theRequested + "; " + theOutcome);
    } catch (e) {
        // Logging must not fail token issuance or the login.
    }
}

function onTokenGenerating(theUserSession, theAuthorizationRequestDetails) {
    // Client Credentials (backend service) flows have no user session: there is
    // no user, launch context, or fhirUser to inject. Skip all user-oriented
    // logic, otherwise the theUserSession accessors below throw a null TypeError
    // and token issuance fails with HTTP 500.
    if (!theUserSession) {
        return;
    }

    // The audience is the FHIR base the app is authorizing against and, with
    // URL-based multitenancy, carries the tenant segment (e.g. .../fhir/VENDOR-A).
    // fhirUser and launch-context URLs below are built from it so tokens minted
    // for a tenant endpoint reference resources at that tenant's base.
    // getAudience() can return null for standalone launch; fall back to the
    // whitelisted "aud" request parameter, then to the shared DEFAULT base.
    var audience = theAuthorizationRequestDetails.getAudience();
    if (!audience) {
        var audParams = theAuthorizationRequestDetails.getRequestParameters();
        if (audParams) {
            audience = audParams.get("aud");
        }
    }
    if (!audience) {
        audience = DEFAULT_AUDIENCE_BASE;
    }
    // Normalise trailing slashes: URLs are built as audience + "/Practitioner/..."
    audience = ("" + audience).replace(/\/+$/, "");

    // getLaunch() is the dedicated accessor; fall back to the whitelisted request
    // parameter if it returns null (can happen with externally-crafted launch tokens).
    var launchRaw = theAuthorizationRequestDetails.getLaunch();
    Log.info("getLaunch() = " + launchRaw);
    if (!launchRaw) {
        var reqParams = theAuthorizationRequestDetails.getRequestParameters();
        if (reqParams) {
            launchRaw = reqParams.get("launch");
            Log.info("launch from requestParameters = " + launchRaw);
        }
    }

    // Sandbox clients only: record how the scopes the claim rule below depends
    // on were read on this build. Logged before any claim is added, so the line
    // is there even when token issuance then fails. Scope names only.
    if (isSandboxClient(theUserSession)) {
        logSandboxScopes("token generation", theUserSession, requestedScopeString(theAuthorizationRequestDetails),
            launchRaw ? "EHR launch" : "standalone launch");
    }

    if (launchRaw) {
        // EHR launch: decode the base64/base64url launch token and inject context.
        var launchParams;
        try {
            var decoded = Converter.base64Decode(launchRaw);
            Log.info("Launch decoded: " + decoded);
            launchParams = JSON.parse(decoded);
        } catch (e) {
            Log.warn("Failed to decode launch token: " + e);
            launchParams = {};
        }
        var params = Object.getOwnPropertyNames(launchParams);
        var requestedScopes = requestedScopesOf(theAuthorizationRequestDetails);

        for (var i = 0; i < params.length; i++) {
            var key = params[i];
            var value = launchParams[key];

            if (key !== "practitioner") {
                // Inject patient, encounter, etc. as launch context, and as a
                // token claim unless Smile CDR adds that claim itself. When the
                // app was granted the matching launch/<key> scope (for example
                // "launch launch/patient"), Smile puts the claim into the token
                // from the launch resource ids, and a second addAccessTokenClaim
                // for the same key throws IllegalArgumentException in
                // SmartTokenEnhancerSvcImpl.validateDontAlreadyHaveClaim, failing
                // the token request with HTTP 500 (measured on aucore
                // 2026-11-27). smileAddsLaunchClaim states which scope sources
                // decide; when none can be read, the claim is added as before.
                theUserSession.addLaunchResourceId(key, value);
                if (!smileAddsLaunchClaim(key, theUserSession, requestedScopes)) {
                    theAuthorizationRequestDetails.addAccessTokenClaim(key, value);
                }
            }

            if (key === "practitioner") {
                // value is a bare ID (e.g. "guthridge-jarred"), not prefixed
                theUserSession.setFhirUserUrl(audience + "/Practitioner/" + value);
            }
        }

        // If launch token had no practitioner, fall back to default launch context
        if (!launchParams.practitioner) {
            defaultFhirUser(theUserSession, audience);
        }

    } else {
        // Standalone launch: use the user's default launch context
        defaultFhirUser(theUserSession, audience);
    }
}

/**
 * The context type a sandbox login carries when its deployment names a
 * Patient (or a Practitioner) as fhirUser; Smile CDR ignores it.
 */
var SANDBOX_FHIRUSER_CONTEXT_TYPE = "sbx-fhiruser";

/** A resource reference fit for fhirUser: Patient/<id> or Practitioner/<id>. */
var SANDBOX_FHIRUSER_RESOURCE_ID = /^(Patient|Practitioner)\/[A-Za-z0-9.-]{1,64}$/;

/**
 * The user's default launch contexts as an array (empty when there are none).
 * Accepts a JS array or a Java collection; throws when the session cannot be
 * read, so each caller decides how to fail open.
 */
function defaultLaunchContextsOf(theUserSession) {
    var contexts = beanProperty(theUserSession, "defaultLaunchContexts", "getDefaultLaunchContexts");
    var list = [];
    if (contexts !== null && contexts !== undefined) {
        if (Array.isArray(contexts)) {
            list = contexts;
        } else if (typeof contexts.iterator === "function") {
            var it = contexts.iterator();
            while (it.hasNext()) {
                list.push(it.next());
            }
        }
    }
    return list;
}

/**
 * The sandbox fhirUser reference ("Patient/<id>" or "Practitioner/<id>") from
 * the first default launch context of type sbx-fhiruser, or null when there is
 * none or its resource id is not such a reference. Never throws.
 */
function sandboxFhirUserOf(theUserSession) {
    try {
        var list = defaultLaunchContextsOf(theUserSession);
        for (var i = 0; i < list.length; i++) {
            var ctx = list[i];
            if (!ctx) {
                continue;
            }
            var type = beanProperty(ctx, "contextType", "getContextType");
            if (type === null || type === undefined ||
                    String(type).toLowerCase() !== SANDBOX_FHIRUSER_CONTEXT_TYPE) {
                continue;
            }
            var resourceId = beanProperty(ctx, "resourceId", "getResourceId");
            if (resourceId === null || resourceId === undefined) {
                return null;
            }
            resourceId = String(resourceId);
            return SANDBOX_FHIRUSER_RESOURCE_ID.test(resourceId) ? resourceId : null;
        }
    } catch (e) {
        try {
            Log.warn("Sandbox fhirUser context skipped: " + e);
        } catch (ignored) {
            // Logging must not fail token issuance either.
        }
    }
    return null;
}

/**
 * Set fhirUser from the user's default launch contexts, used when the launch
 * names no practitioner. The "practitioner" context wins; without one, a
 * sandbox login's "sbx-fhiruser" context (written by aehrc/sparked-sandbox,
 * for example "Patient/<sandbox id>-<patient>" when the deployment names a
 * Patient as fhirUser) is used. Non-sandbox users have no sbx-fhiruser
 * context, so for them this is exactly the practitioner rule as before.
 * Anything else leaves fhirUser unset here, as before.
 */
function defaultFhirUser(theUserSession, theAudience) {
    var ctx = theUserSession.getOrCreateDefaultLaunchContext("practitioner");
    if (ctx && ctx.resourceId) {
        // resourceId is stored as "Practitioner/xxx" by manage_smart_users.py
        theUserSession.setFhirUserUrl(theAudience + "/" + ctx.resourceId);
        return;
    }
    var sandboxFhirUser = sandboxFhirUserOf(theUserSession);
    if (sandboxFhirUser !== null) {
        theUserSession.setFhirUserUrl(theAudience + "/" + sandboxFhirUser);
    }
}

/** Matches the extra patient context types a sandbox writes: sbx-patient-<n>. */
var SANDBOX_PATIENT_CONTEXT_TYPE = /^sbx-patient-([0-9]+)$/i;

/**
 * Standalone patient picker for sandbox logins.
 *
 * Smile CDR calls this after sign-in, before the launch context is chosen.
 * Each person added to theContextSelectionChoices is offered on a selection
 * screen, and the chosen person's associatedPatientContextResourceId becomes
 * the patient launch context. When no person is added, no screen is shown and
 * the login continues as before.
 *
 * Where the choices come from: Smile CDR stores at most one default launch
 * context per context type per user (a user with three contexts of type
 * "patient" is refused with HTTP 500, unique constraint
 * idx_userdeflnchctx_user_ctyp on user and context type; measured on aucore
 * 2026-11-27). It does accept context types of its users' own choosing and
 * returns them unchanged. So a sandbox stores its default starter patient as
 * the "patient" context, which Smile uses as the launch patient when no
 * choice is made, and each further starter patient as a context of type
 * sbx-patient-<n> (sbx-patient-2, sbx-patient-3, ...), which Smile ignores.
 * The choices are the "patient" context first, then every sbx-patient-<n>
 * context in ascending order of n, skipping empty resource ids and any
 * resource id already offered. Only the first "patient" context counts, in
 * case a build ever returns more than one.
 *
 * Scope: it acts only for clients whose id starts with "sbx-" (the sandbox
 * clients that aehrc/sparked-sandbox registers as sbx-<id>-<kind>), only on a
 * standalone launch, that is launch/patient granted and launch not granted
 * (an EHR launch already names its patient; when the approved scopes cannot
 * be read, nothing is offered), and only when that yields two or more choices (all in
 * the sandbox's own partition). It offers nothing else and never changes
 * authorities or scopes, so every other client on aucore is untouched.
 *
 * Fail-open: any error is logged and swallowed, and the login continues.
 * Persons are added only after the whole list is built, so a failure while
 * reading the session adds no person and the login continues as it would
 * without this function. Adding is not atomic: Smile CDR offers no call to
 * take a person back. Each person's associatedPatientContextResourceId is set
 * before its names, so a failure while adding leaves the persons completed so
 * far (each with its patient id and names) plus at most one further person:
 * with its patient id but no names when a name write fails (givenName is
 * written first, so its failure leaves both names unset), or with no
 * properties at all when addPerson succeeds and the patient id write itself
 * fails. What the selection screen does with such a partial list is not
 * measured.
 */
function onSmartLoginPreContextSelection(theUserSession, theContextSelectionChoices) {
    try {
        if (!theUserSession || !theContextSelectionChoices) {
            return;
        }
        if (!isSandboxClient(theUserSession)) {
            return;
        }

        // A standalone launch: launch/patient granted and launch not granted.
        // Unknown (the approved scopes cannot be read) offers no chooser. The
        // diagnostic line names the request as unavailable: this callback is
        // given no authorization request details.
        if (granted(theUserSession, "launch/patient") !== true || granted(theUserSession, "launch") !== false) {
            logSandboxScopes("context selection", theUserSession, "(not available here)", "chooser not offered");
            return;
        }

        var list = defaultLaunchContextsOf(theUserSession);

        var primary = null;
        var extras = [];
        for (var i = 0; i < list.length; i++) {
            var ctx = list[i];
            if (!ctx) {
                continue;
            }
            var type = beanProperty(ctx, "contextType", "getContextType");
            var resourceId = beanProperty(ctx, "resourceId", "getResourceId");
            if (type === null || type === undefined || resourceId === null || resourceId === undefined ||
                    String(resourceId) === "") {
                continue;
            }
            type = String(type);
            if (type.toLowerCase() === "patient") {
                if (primary === null) {
                    primary = String(resourceId);
                }
                continue;
            }
            var match = SANDBOX_PATIENT_CONTEXT_TYPE.exec(type);
            if (match) {
                extras.push({ n: parseInt(match[1], 10), index: i, id: String(resourceId) });
            }
        }
        // Ascending by n; the list position breaks ties so the order is stable.
        extras.sort(function (a, b) {
            return a.n !== b.n ? a.n - b.n : a.index - b.index;
        });

        var choices = [];
        if (primary !== null) {
            choices.push(primary);
        }
        for (var k = 0; k < extras.length; k++) {
            if (choices.indexOf(extras[k].id) < 0) {
                choices.push(extras[k].id);
            }
        }
        logSandboxScopes("context selection", theUserSession, "(not available here)",
            "standalone launch, " + choices.length + " patient choices");
        if (choices.length < 2) {
            return;
        }

        for (var j = 0; j < choices.length; j++) {
            var person = theContextSelectionChoices.addPerson();
            // Patient id first: see "Fail-open" above.
            person.associatedPatientContextResourceId = choices[j];
            person.givenName = "Patient";
            person.familyName = choices[j];
        }
    } catch (e) {
        try {
            Log.warn("Sandbox patient picker skipped: " + e);
        } catch (ignored) {
            // Logging must not fail the login either.
        }
    }
}

function onPostAuthorize(theDetails) {
    Log.info("Post-authorize details: " + theDetails);
}
