python3 - <<'EOF'
import requests, json, base64, re
from urllib.parse import urlparse

def decode_jwt(token):
    payload = token.split('.')[1]
    payload += '=' * (4 - len(payload) % 4)
    return json.loads(base64.b64decode(payload))

AUTHORIZE_URL = (
    "https://smile.sparked-fhir.com/aucore/smartauth/oauth/authorize"
    "?response_type=code&client_id=techentrro-ps-app"
    "&redirect_uri=https://localhost:5173/&scope=openid%20fhirUser%20launch%20patient/*.rs"
    "&state=test&aud=https://smile.sparked-fhir.com/aucore/fhir/DEFAULT"
    "&launch=eyJwYXRpZW50IjoiaXJ2aW5lLXJvbm55LWxhd3JlbmNlIiwicHJhY3RpdGlvbmVyIjoiZ3V0aHJpZGdlLWphcnJlZCJ9"
)

def fresh_test():
    s = requests.Session()
    r = s.get(AUTHORIZE_URL, allow_redirects=True)
    csrf = re.search(r'name="_csrf" value="([^"]+)"', r.text).group(1)
    # Logout first to kill any existing session
    s.post("https://smile.sparked-fhir.com/aucore/smartauth/authenticate",
        data={"username": "shovan-roy", "password": "KH1uWIqZIb&e6&ee", "_csrf": csrf}, allow_redirects=False)
    s.get("https://smile.sparked-fhir.com/aucore/smartauth/logout", allow_redirects=False)
    s.cookies.clear()

    # Fresh login
    r = s.get(AUTHORIZE_URL, allow_redirects=True)
    csrf = re.search(r'name="_csrf" value="([^"]+)"', r.text).group(1)
    r = s.post("https://smile.sparked-fhir.com/aucore/smartauth/authenticate",
        data={"username": "shovan-roy", "password": "KH1uWIqZIb&e6&ee", "_csrf": csrf}, allow_redirects=False)

    loc = ''
    for _ in range(15):
        loc = r.headers.get('Location', '')
        if not loc: break
        if urlparse(loc).hostname == 'localhost': break
        url = loc if loc.startswith('http') else f"https://smile.sparked-fhir.com{loc}"
        r = s.get(url, allow_redirects=False)

    code = re.search(r'[?&]code=([^&\s]+)', loc).group(1)
    r = requests.post("https://smile.sparked-fhir.com/aucore/smartauth/oauth/token",
        data={"grant_type": "authorization_code", "client_id": "techentrro-ps-app",
              "redirect_uri": "https://localhost:5173/", "code": code},
        headers={"Content-Type": "application/x-www-form-urlencoded"})
    tokens = r.json()
    at_claims = decode_jwt(tokens["access_token"])
    id_claims = decode_jwt(tokens["id_token"])

    print("=== token response body (what the app receives) ===")
    print(f"  patient:       {tokens.get('patient')}")
    print(f"  fhirUser:      {tokens.get('fhirUser') or id_claims.get('fhirUser')}")
    print(f"  resourceType:  {tokens.get('resourceType') or id_claims.get('resourceType') or 'n/a'}")
    print(f"  scope:         {tokens.get('scope')}")
    print("\n=== id_token claims ===")
    print(f"  fhirUser:    {id_claims.get('fhirUser')}")
    print(f"  iat:         {id_claims.get('iat')}")
    print("\n=== access_token claims ===")
    print(f"  fhirContext: {at_claims.get('fhirContext')}")
    print(f"  patient:     {at_claims.get('patient')}")

    requests.post("https://smile.sparked-fhir.com/aucore/smartauth/session/token/revoke",
        data={"token": tokens["access_token"], "token_type": "access_token"},
        headers={"Content-Type": "application/x-www-form-urlencoded"})
    print("\nToken revoked.")

fresh_test()
EOF