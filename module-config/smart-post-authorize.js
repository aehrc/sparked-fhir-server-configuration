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

/*
 * Reading what Smile CDR hands the script. On aucore (Smile CDR 2026.05.R01)
 * scripts run on a sandboxed GraalVM whose host access policy may expose only
 * the documented callback methods (getOrCreateDefaultLaunchContext,
 * addLaunchResourceId, addAccessTokenClaim, getLaunch work there, measured),
 * so the generic Java methods of a Set or List (contains, iterator, size,
 * get) may be refused. Every read below therefore tries several shapes, each
 * on its own, never throws, and falls back to the behaviour before it when
 * nothing answers. For sbx- clients one log line per callback names the
 * shape that worked.
 */

/**
 * Where the user's approved scopes come from, in order. They are a
 * java.util.Set<String> (UserSessionDetailsJson.getApprovedScopes(), never
 * null), which has none of the JS array methods (indexOf, includes, length).
 */
var APPROVED_SCOPE_SOURCES = [
    { name: "getApprovedScopes()", read: function (theUserSession) { return theUserSession.getApprovedScopes(); } },
    { name: "approvedScopes", read: function (theUserSession) { return theUserSession.approvedScopes; } }
];

/**
 * The entries of a java.util collection's string form, "[a, b, c]" ("[]"
 * when empty), as an array of strings; null when theText is not of that
 * form. Scope names hold no commas or whitespace.
 */
function javaCollectionStringValues(theText) {
    var match = /^\[([\s\S]*)\]$/.exec(theText);
    if (!match || /^\[object /.test(theText)) {
        return null;
    }
    var parts = match[1].split(/[\s,]+/);
    var out = [];
    for (var i = 0; i < parts.length; i++) {
        if (parts[i]) {
            out.push(parts[i]);
        }
    }
    return out;
}

/** Throws unless theSet can be a host collection: a JS array or primitive never is. */
function requireHostObject(theSet) {
    if (theSet === null || typeof theSet !== "object" || Array.isArray(theSet)) {
        throw new Error("not a host collection (" + (Array.isArray(theSet) ? "JS array" : typeof theSet) + ")");
    }
}

/** A reader over approved scope names already copied into a JS array. */
function scopeListReader(theValues) {
    return {
        has: function (theScope) { return theValues.indexOf(theScope) >= 0; },
        size: theValues.length,
        values: theValues
    };
}

/**
 * The shapes in which an approved scope set can be asked, in order. Each
 * open() takes the set and returns { has(scope), size, values } or throws
 * when the set does not answer in that shape.
 * - contains(): the Set's own contains(), which must answer with a boolean;
 *   size() and the string form only describe it (unreadable leaves them
 *   null, and an unreadable size does not count as empty).
 * - for-of: GraalJS iterates a host Iterable when its policy allows it.
 * - String(): the Set's string form "[a, b, c]", parsed.
 */
var APPROVED_SCOPE_SHAPES = [
    {
        label: function (theSource) { return theSource + ".contains()"; },
        open: function (theSet) {
            var probe = theSet.contains("launch");
            if (typeof probe !== "boolean") {
                throw new Error("contains() gave " + typeof probe);
            }
            var size = null;
            try {
                size = Number(theSet.size());
                if (isNaN(size)) {
                    size = null;
                }
            } catch (e) {
                size = null;
            }
            var values = null;
            try {
                values = javaCollectionStringValues(String(theSet));
            } catch (e) {
                values = null;
            }
            return {
                has: function (theScope) { return theSet.contains(theScope); },
                size: size,
                values: values
            };
        }
    },
    {
        label: function (theSource) { return "for-of " + theSource; },
        open: function (theSet) {
            requireHostObject(theSet);
            var values = [];
            for (var scope of theSet) {
                values.push(String(scope));
            }
            return scopeListReader(values);
        }
    },
    {
        label: function (theSource) { return "String(" + theSource + ")"; },
        open: function (theSet) {
            requireHostObject(theSet);
            var values = javaCollectionStringValues(String(theSet));
            if (values === null) {
                throw new Error("String() is not a [a, b] list");
            }
            return scopeListReader(values);
        }
    }
];

/**
 * Read the user's approved scopes once: every shape on every source, in
 * that order, the first that answers wins. Returns { method, has, size,
 * values } or, when nothing answers, { method: null, failures }. Never throws.
 */
function readApprovedScopes(theUserSession) {
    var failures = [];
    var sources = [];
    for (var i = 0; i < APPROVED_SCOPE_SOURCES.length; i++) {
        try {
            sources.push({ name: APPROVED_SCOPE_SOURCES[i].name, value: APPROVED_SCOPE_SOURCES[i].read(theUserSession) });
        } catch (e) {
            failures.push(APPROVED_SCOPE_SOURCES[i].name + " threw " + e);
        }
    }
    for (var j = 0; j < APPROVED_SCOPE_SHAPES.length; j++) {
        for (var k = 0; k < sources.length; k++) {
            var method = APPROVED_SCOPE_SHAPES[j].label(sources[k].name);
            try {
                var reader = APPROVED_SCOPE_SHAPES[j].open(sources[k].value);
                reader.method = method;
                return reader;
            } catch (e) {
                failures.push(method + " failed: " + e);
            }
        }
    }
    return { method: null, failures: failures };
}

/**
 * Whether theScope is among the approved scopes theApproved (from
 * readApprovedScopes): true or false, or null (unknown) when nothing read
 * them or the answer is not a boolean. An empty set (size 0) counts as
 * unknown, as before: an approved login always has at least one scope, so
 * empty means "not populated at this point".
 */
function granted(theApproved, theScope) {
    if (theApproved.method === null) {
        return null;
    }
    var answer;
    try {
        answer = theApproved.has(theScope);
    } catch (e) {
        return null;
    }
    if (typeof answer !== "boolean") {
        return null;
    }
    return answer || theApproved.size !== 0 ? answer : null;
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
function smileAddsLaunchClaim(theKey, theApproved, theRequestedScopes) {
    var scope = "launch/" + theKey;
    var isGranted = granted(theApproved, scope);
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
 * How the approved scopes were read, for the sandbox log line: the method
 * that worked with its size and values, or why each one failed. Scope names
 * only.
 */
function approvedScopesSummary(theApproved) {
    if (theApproved.method === null) {
        return "approved read=none (" + theApproved.failures.join("; ") + ")";
    }
    return "approved read=" + theApproved.method +
        " size=" + (theApproved.size === null ? "unreadable" : theApproved.size) +
        " scopes=" + (theApproved.values === null ? "unreadable" : "[" + theApproved.values.join(", ") + "]");
}

/**
 * Log the one diagnostic line of a sandbox callback: how the approved scopes
 * were read, which method read each context type found (types only, never a
 * resource id), the requested scope string and the outcome. Never throws.
 */
function logSandboxLine(theWhere, theApproved, theContexts, theRequested, theOutcome) {
    try {
        Log.info("Sandbox scopes at " + theWhere + ": " + approvedScopesSummary(theApproved) +
            "; contexts=" + (theContexts.length > 0 ? theContexts.join(", ") : "none") +
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

    // Sandbox clients only: one line recording how the scopes and contexts
    // this token depends on were read on this build. It is logged in the
    // finally block, so it is there even when token issuance then fails.
    var trace = {
        approved: null,
        contexts: contextReader(theUserSession, "Sandbox fhirUser context skipped: "),
        flow: "standalone launch"
    };
    try {
        injectLaunchContext(theUserSession, theAuthorizationRequestDetails, trace);
    } finally {
        if (isSandboxClient(theUserSession)) {
            logSandboxLine("token generation",
                trace.approved !== null ? trace.approved : readApprovedScopes(theUserSession),
                trace.contexts.found, requestedScopeString(theAuthorizationRequestDetails), trace.flow);
        }
    }
}

function injectLaunchContext(theUserSession, theAuthorizationRequestDetails, theTrace) {
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

    if (launchRaw) {
        theTrace.flow = "EHR launch";
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
        theTrace.approved = readApprovedScopes(theUserSession);

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
                if (!smileAddsLaunchClaim(key, theTrace.approved, requestedScopes)) {
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
            defaultFhirUser(theUserSession, audience, theTrace.contexts);
        }

    } else {
        // Standalone launch: use the user's default launch context
        defaultFhirUser(theUserSession, audience, theTrace.contexts);
    }
}

/**
 * The resource id of the user's default launch context of type theType, read
 * with the documented UserSessionDetails.getOrCreateDefaultLaunchContext(type)
 * (the read main has always made for "practitioner"): ctx.resourceId, then
 * ctx.getResourceId(), each on its own. Returns { id, method }, or null when
 * the context is missing, its resource id is empty, or nothing could be read.
 * Never throws.
 */
function launchContextByType(theUserSession, theType) {
    var ctx;
    try {
        ctx = theUserSession.getOrCreateDefaultLaunchContext(theType);
    } catch (e) {
        return null;
    }
    if (ctx === null || ctx === undefined) {
        return null;
    }
    var reads = [
        { name: ".resourceId", read: function () { return ctx.resourceId; } },
        { name: ".getResourceId()", read: function () { return ctx.getResourceId(); } }
    ];
    for (var i = 0; i < reads.length; i++) {
        try {
            var value = reads[i].read();
            if (value !== null && value !== undefined && String(value) !== "") {
                return { id: String(value), method: "getOrCreateDefaultLaunchContext()" + reads[i].name };
            }
        } catch (e) {
            // Try the next read.
        }
    }
    return null;
}

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
 * Reads the user's default launch contexts for one callback. byType(type,
 * useList) reads a type with launchContextByType and, when that yields no
 * resource id and useList is set, falls back to the default launch context
 * list (defaultLaunchContexts or getDefaultLaunchContexts(), its context
 * types matched case-insensitively, the first entry with a resource id
 * counting). The list is the second fallback: on a host access policy that
 * refuses a List's iterator it reads as empty. It is read at most once,
 * whole: when any part of it throws, theListWarning plus the error is logged
 * as a warning and the list counts as empty. found records "<type> via
 * <method>" for each type found, for the sandbox log line. Never throws.
 */
function contextReader(theUserSession, theListWarning) {
    var entries = null;
    var found = [];

    function list() {
        if (entries !== null) {
            return entries;
        }
        try {
            var read = [];
            var raw = defaultLaunchContextsOf(theUserSession);
            for (var i = 0; i < raw.length; i++) {
                var ctx = raw[i];
                if (!ctx) {
                    continue;
                }
                var type = beanProperty(ctx, "contextType", "getContextType");
                var id = beanProperty(ctx, "resourceId", "getResourceId");
                read.push({
                    type: type === null || type === undefined ? null : String(type).toLowerCase(),
                    id: id === null || id === undefined || String(id) === "" ? null : String(id)
                });
            }
            entries = read;
        } catch (e) {
            entries = [];
            try {
                Log.warn(theListWarning + e);
            } catch (ignored) {
                // Logging must not fail token issuance or the login either.
            }
        }
        return entries;
    }

    function byType(theType, theUseList) {
        var hit = launchContextByType(theUserSession, theType);
        if (hit !== null) {
            found.push(theType + " via " + hit.method);
            return hit.id;
        }
        if (!theUseList) {
            return null;
        }
        var all = list();
        for (var i = 0; i < all.length; i++) {
            if (all[i].type === theType && all[i].id !== null) {
                found.push(theType + " via defaultLaunchContexts");
                return all[i].id;
            }
        }
        return null;
    }

    return { byType: byType, list: list, found: found };
}

/**
 * The context type a sandbox login carries when its deployment names a
 * Patient (or a Practitioner) as fhirUser; Smile CDR ignores it.
 */
var SANDBOX_FHIRUSER_CONTEXT_TYPE = "sbx-fhiruser";

/** A resource reference fit for fhirUser: Patient/<id> or Practitioner/<id>. */
var SANDBOX_FHIRUSER_RESOURCE_ID = /^(Patient|Practitioner)\/[A-Za-z0-9.-]{1,64}$/;

/**
 * Set fhirUser from the user's default launch contexts, used when the launch
 * names no practitioner. The "practitioner" context wins (read with
 * getOrCreateDefaultLaunchContext only, as on main); without one, a sandbox
 * login's "sbx-fhiruser" context (written by aehrc/sparked-sandbox, for
 * example "Patient/<sandbox id>-<patient>" when the deployment names a
 * Patient as fhirUser) is used when its resource id is Patient/<id> or
 * Practitioner/<id>. The sbx-fhiruser read happens only for a sandbox client
 * (isSandboxClient), so a non-sandbox login gets exactly the practitioner rule
 * as before and getOrCreateDefaultLaunchContext is called for it only with
 * "practitioner", as on main. Anything else leaves
 * fhirUser unset here, as before. Never throws.
 */
function defaultFhirUser(theUserSession, theAudience, theContexts) {
    // resourceId is stored as "Practitioner/xxx" by manage_smart_users.py
    var practitioner = theContexts.byType("practitioner", false);
    if (practitioner !== null) {
        theUserSession.setFhirUserUrl(theAudience + "/" + practitioner);
        return;
    }
    // Sandbox clients only: getOrCreateDefaultLaunchContext creates a context
    // of any type the session lacks, so a non-sandbox login must never reach
    // this read.
    if (!isSandboxClient(theUserSession)) {
        return;
    }
    var sandboxFhirUser = theContexts.byType(SANDBOX_FHIRUSER_CONTEXT_TYPE, true);
    if (sandboxFhirUser !== null && SANDBOX_FHIRUSER_RESOURCE_ID.test(sandboxFhirUser)) {
        theUserSession.setFhirUserUrl(theAudience + "/" + sandboxFhirUser);
    }
}

/** Matches the extra patient context types a sandbox writes: sbx-patient-<n>. */
var SANDBOX_PATIENT_CONTEXT_TYPE = /^sbx-patient-([0-9]+)$/i;

/** The sbx-patient-<n> context types read by type, in order. */
var SANDBOX_PATIENT_MIN = 2;
var SANDBOX_PATIENT_MAX = 9;

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
 * Each type is read with getOrCreateDefaultLaunchContext(type): "patient",
 * then sbx-patient-2 to sbx-patient-9, skipping a missing or empty one; the
 * default launch context list is the second fallback (contextReader), and
 * any further sbx-patient-<n> it names is offered too. The choices are the
 * "patient" context first, then the sbx-patient-<n> contexts in ascending
 * order of n, each resource id offered once and exactly as stored.
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
        var approved = readApprovedScopes(theUserSession);
        if (granted(approved, "launch/patient") !== true || granted(approved, "launch") !== false) {
            logSandboxLine("context selection", approved, [], "(not available here)", "chooser not offered");
            return;
        }

        var contexts = contextReader(theUserSession, "Sandbox patient picker skipped the context list: ");
        var primary = contexts.byType("patient", true);
        var extras = [];
        var readByType = {};
        for (var n = SANDBOX_PATIENT_MIN; n <= SANDBOX_PATIENT_MAX; n++) {
            var id = contexts.byType("sbx-patient-" + n, true);
            readByType[n] = true;
            if (id !== null) {
                extras.push({ n: n, index: -1, id: id });
            }
        }
        // Any further sbx-patient-<n> the list names (n outside 2 to 9).
        var list = contexts.list();
        for (var i = 0; i < list.length; i++) {
            var match = list[i].type === null ? null : SANDBOX_PATIENT_CONTEXT_TYPE.exec(list[i].type);
            if (match && list[i].id !== null) {
                var number = parseInt(match[1], 10);
                if (!readByType[number]) {
                    extras.push({ n: number, index: i, id: list[i].id });
                    contexts.found.push(list[i].type + " via defaultLaunchContexts");
                }
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
        logSandboxLine("context selection", approved, contexts.found, "(not available here)",
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
