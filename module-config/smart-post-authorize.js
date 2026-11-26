/**
 * SMART Post-Authorization Callback Script
 *
 * Called just prior to issuing a new access token. Handles two cases:
 *
 * 1. EHR Launch (launch token present): decodes the base64 launch parameter,
 *    injects patient/encounter context into the token, and sets fhirUser to
 *    the Practitioner from the launch token (or falls back to the user's
 *    default launch context).
 *
 * 2. Standalone Launch (no launch token): sets fhirUser from the user's
 *    default launch context Practitioner.
 *
 * It also offers a patient picker on standalone launches through sandbox
 * clients only (onSmartLoginPreContextSelection below).
 *
 * By default SmileCDR sets fhirUser to an auto-generated RelatedPerson.
 * This script overrides that with the correct Practitioner in both flows.
 *
 * Config key: post_authorize_script.file (SMART Outbound Security module)
 * Docs: https://smilecdr.com/docs/smart/user_profile.html
 */

// Fallback audience when neither getAudience() nor the whitelisted "aud"
// request parameter yields a value (some standalone launches). This base is
// node-specific: scripts/sync_smart_auth.py rewrites the node segment when
// pushing this script to each node, so keep the URL on a single line.
var DEFAULT_AUDIENCE_BASE = "https://smile.sparked-fhir.com/aucore/fhir/DEFAULT";

/**
 * Flatten a scope source into an array of scope strings, or null when it
 * cannot be read. Accepts a space-separated string, a JS array, or a Java
 * collection (List or Set, read by index or through its iterator).
 */
function scopeList(theScopes) {
    if (theScopes === null || theScopes === undefined) {
        return null;
    }
    var items = [];
    if (typeof theScopes === "string") {
        items = [theScopes];
    } else if (Array.isArray(theScopes)) {
        items = theScopes;
    } else if (typeof theScopes.iterator === "function") {
        var it = theScopes.iterator();
        while (it.hasNext()) {
            items.push(it.next());
        }
    } else if (typeof theScopes.size === "function" && typeof theScopes.get === "function") {
        for (var i = 0; i < theScopes.size(); i++) {
            items.push(theScopes.get(i));
        }
    } else {
        return null;
    }
    var out = [];
    for (var j = 0; j < items.length; j++) {
        if (items[j] === null || items[j] === undefined) {
            continue;
        }
        var parts = String(items[j]).split(/\s+/);
        for (var k = 0; k < parts.length; k++) {
            if (parts[k]) {
                out.push(parts[k]);
            }
        }
    }
    return out;
}

/** Read a bean property, trying the property form first and then its getter. */
function beanProperty(theObject, theName, theGetter) {
    var value = theObject[theName];
    if ((value === null || value === undefined) && typeof theObject[theGetter] === "function") {
        value = theObject[theGetter]();
    }
    return value;
}

/** The user's approved scopes as an array, or null when they cannot be read. */
function approvedScopesOf(theUserSession) {
    try {
        var scopes = scopeList(beanProperty(theUserSession, "approvedScopes", "getApprovedScopes"));
        // An empty set is treated as unreadable: an approved login always has
        // at least one scope, so empty means "not populated at this point".
        return scopes && scopes.length > 0 ? scopes : null;
    } catch (e) {
        return null;
    }
}

/**
 * The scopes of this token request: the user's approved scopes, else the
 * whitelisted "scope" request parameter, else null when neither can be read.
 */
function tokenScopesOf(theUserSession, theAuthorizationRequestDetails) {
    var scopes = approvedScopesOf(theUserSession);
    if (scopes) {
        return scopes;
    }
    try {
        var reqParams = theAuthorizationRequestDetails.getRequestParameters();
        if (reqParams) {
            scopes = scopeList(reqParams.get("scope"));
            return scopes && scopes.length > 0 ? scopes : null;
        }
    } catch (e) {
        // Fall through: unreadable.
    }
    return null;
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
    var ctx;

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
        var tokenScopes = tokenScopesOf(theUserSession, theAuthorizationRequestDetails);

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
                // 2026-11-27). When the scopes cannot be read, the claim is
                // added as before.
                theUserSession.addLaunchResourceId(key, value);
                if (!tokenScopes || tokenScopes.indexOf("launch/" + key) < 0) {
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
            ctx = theUserSession.getOrCreateDefaultLaunchContext("practitioner");
            if (ctx && ctx.resourceId) {
                // resourceId is stored as "Practitioner/xxx" by manage_smart_users.py
                theUserSession.setFhirUserUrl(audience + "/" + ctx.resourceId);
            }
        }

    } else {
        // Standalone launch: use the user's default launch context
        ctx = theUserSession.getOrCreateDefaultLaunchContext("practitioner");
        if (ctx && ctx.resourceId) {
            // resourceId is stored as "Practitioner/xxx" by manage_smart_users.py
            theUserSession.setFhirUserUrl(audience + "/" + ctx.resourceId);
        }
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
 * standalone launch that asked for launch/patient (an EHR launch already
 * names its patient), and only when that yields two or more choices (all in
 * the sandbox's own partition). It offers nothing else and never changes
 * authorities or scopes, so every other client on aucore is untouched.
 *
 * Fail-open: any error is logged and swallowed, and persons are added only
 * after the whole list is built, so a failure while reading the session adds
 * no person and the login continues as it would without this function.
 */
function onSmartLoginPreContextSelection(theUserSession, theContextSelectionChoices) {
    try {
        if (!theUserSession || !theContextSelectionChoices) {
            return;
        }
        var clientId = beanProperty(theUserSession, "oidcClientId", "getOidcClientId");
        if (clientId === null || clientId === undefined || String(clientId).indexOf("sbx-") !== 0) {
            return;
        }

        var scopes = approvedScopesOf(theUserSession);
        if (!scopes || scopes.indexOf("launch/patient") < 0 || scopes.indexOf("launch") >= 0) {
            return;
        }

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
        if (choices.length < 2) {
            return;
        }

        for (var j = 0; j < choices.length; j++) {
            var person = theContextSelectionChoices.addPerson();
            person.givenName = "Patient";
            person.familyName = choices[j];
            person.associatedPatientContextResourceId = choices[j];
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
