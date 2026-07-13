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
 * By default SmileCDR sets fhirUser to an auto-generated RelatedPerson.
 * This script overrides that with the correct Practitioner in both flows.
 *
 * Config key: post_authorize_script.file (SMART Outbound Security module)
 * Docs: https://smilecdr.com/docs/smart/user_profile.html
 */
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
        audience = "https://smile.sparked-fhir.com/aucore/fhir/DEFAULT";
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

        for (var i = 0; i < params.length; i++) {
            var key = params[i];
            var value = launchParams[key];

            if (key !== "practitioner") {
                // Inject patient, encounter, etc. as token claims and launch context
                theAuthorizationRequestDetails.addAccessTokenClaim(key, value);
                theUserSession.addLaunchResourceId(key, value);
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

function onPostAuthorize(theDetails) {
    Log.info("Post-authorize details: " + theDetails);
}
