#!/usr/bin/env python3
"""
Generate the Smile CDR OIDC token-signing keystore and store it in AWS Secrets Manager.

WHY THIS EXISTS
---------------
smart_auth is configured with `openid.signing.keystore_id = smilecdr-token-signing`
(module-config/simplified-multinode.yaml), but nothing in this repository ever
created that keystore. On the live server it exists because it was created by
hand through the admin console, which means it is runtime state in the database
and not reproducible from git.

A server built from this repository alone therefore fails to start:

    ConfigurationException: No keystore with id smilecdr-token-signing
      -> tokenEnhancer bean fails
      -> smart_auth FAILED_TO_START
      -> fhir_endpoint gets no OIDC provider and fails
      -> fhirweb_endpoint depends on fhir_endpoint and fails

Found 2026-08-02 on the first cold boot of the sparkey deployment.

HOW THE FIX WORKS
-----------------
Smile CDR seeds keystores declaratively from the file named by the clustermgr
property `seed_keystores.file`, which the Helm chart already defaults to
`classpath:/config_seeding/keystores.json`. The container ships a sample there
containing only the demo keystore, so all that is needed is to replace that file.

Rather than commit key material, this script writes the whole keystores.json
document (with the private JWK inline) into AWS Secrets Manager. The chart then
mounts that secret over the sample path with the Secrets Store CSI driver, the
same mechanism already used for users.json. So:

  - the private key exists only in Secrets Manager, never in git and never in
    terraform state
  - the deployment is reproducible: terraform apply on an empty database brings
    up a working smart_auth with no console step
  - rotation is re-running this script and restarting the pod

USAGE
-----
    # create (fails if the secret already exists, so it cannot clobber a key)
    python scripts/generate_token_signing_keystore.py --secret-name smilecdr-token-signing-jwks

    # deliberate rotation of an existing key
    python scripts/generate_token_signing_keystore.py --secret-name ... --rotate

    # see what would be written
    python scripts/generate_token_signing_keystore.py --secret-name ... --dry-run

Requires: boto3, cryptography, and AWS credentials for the target account.

A NOTE ON REUSING THE LIVE KEY
------------------------------
This generates a NEW keypair rather than copying the live server's. Smile CDR
does not expose private keys through the admin API, and moving one around by
hand is exactly the practice this script exists to end.

The consequence is that at DNS cutover the JWKS changes. Standard OIDC clients
re-fetch the JWKS when they see an unknown `kid`, so this is normally invisible,
but access tokens issued by the old server before the flip will not validate
against the new one and those sessions have to re-authenticate. Access tokens
are short-lived, the old server is being retired anyway, and the alternative is
worse. Mention it in the cutover announcement.
"""

import argparse
import base64
import json
import sys
import uuid

# boto3 is imported inside main() rather than at module scope, so the key
# generation below can be imported and unit-tested without AWS libraries present.
try:
    from cryptography.hazmat.primitives.asymmetric import rsa
except ImportError:
    sys.exit("Error: cryptography is required. pip install -r scripts/requirements.txt")


KEYSTORE_ID = "smilecdr-token-signing"
DEFAULT_REGION = "ap-southeast-2"
# Path the chart's clustermgr `seed_keystores.file` already points at. The
# container ships a sample here holding only the demo keystore; the CSI mount
# replaces it.
SEED_PATH = "classpath:/config_seeding/keystores.json"


def b64url_uint(value: int) -> str:
    """Base64url-encode an integer as an unsigned big-endian byte string, per RFC 7518."""
    raw = value.to_bytes((value.bit_length() + 7) // 8, "big")
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def generate_private_jwk(key_size: int = 2048) -> dict:
    """Generate an RSA private key as a JWK.

    RS256 with a 2048-bit key: what Smile CDR signs OIDC tokens with by default
    and what every SMART client is expected to support.
    """
    key = rsa.generate_private_key(public_exponent=65537, key_size=key_size)
    n = key.private_numbers()
    pub = n.public_numbers

    return {
        "kty": "RSA",
        "use": "sig",
        "alg": "RS256",
        # A stable, unique kid. Clients key their JWKS cache on this, so a new
        # key must carry a new kid or they will keep using the cached one.
        "kid": str(uuid.uuid4()),
        "n": b64url_uint(pub.n),
        "e": b64url_uint(pub.e),
        "d": b64url_uint(n.d),
        "p": b64url_uint(n.p),
        "q": b64url_uint(n.q),
        "dp": b64url_uint(n.dmp1),
        "dq": b64url_uint(n.dmq1),
        "qi": b64url_uint(n.iqmp),
    }


def build_keystores_document(private_jwk: dict) -> dict:
    """Build the full keystores.json seed document.

    Keeps `default-keystore` alongside the signing one. It is what the shipped
    sample defines and other modules may reference it; dropping it would be an
    unrelated change smuggled in under this fix.
    """
    return {
        "keystores": [
            {
                "keystoreId": "default-keystore",
                "jsonKeys": "",
                "filePath": "classpath:/smilecdr-demo.jwks",
            },
            {
                "keystoreId": KEYSTORE_ID,
                # Inline, so there is exactly one artefact to mount and no second
                # file to keep in step with it.
                "jsonKeys": json.dumps({"keys": [private_jwk]}),
                "filePath": "",
            },
        ]
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--secret-name", required=True,
                    help="AWS Secrets Manager secret name, e.g. smilecdr-token-signing-jwks")
    ap.add_argument("--region", default=DEFAULT_REGION)
    ap.add_argument("--key-size", type=int, default=2048)
    ap.add_argument("--rotate", action="store_true",
                    help="Overwrite an existing secret. Without this the script refuses to "
                         "touch one, so it cannot silently invalidate a live signing key.")
    ap.add_argument("--dry-run", action="store_true",
                    help="Print the public half of what would be written and exit.")
    args = ap.parse_args()

    jwk = generate_private_jwk(args.key_size)
    document = build_keystores_document(jwk)
    # Wrapped in a "content" field rather than stored raw, to match the shape of
    # the existing smilecdr-users-json secret. The chart's secretKeyMap extracts a
    # named field with jmesPath, so this reuses a mount path already proven on
    # this cluster instead of inventing a second convention.
    payload = json.dumps({"content": json.dumps(document, indent=2)})

    public_only = {k: v for k, v in jwk.items() if k in ("kty", "use", "alg", "kid", "n", "e")}
    print(f"Generated {args.key_size}-bit RSA signing key")
    print(f"  keystoreId: {KEYSTORE_ID}")
    print(f"  kid:        {jwk['kid']}")
    print(f"  seeded via: {SEED_PATH}")
    print(f"  public JWK: {json.dumps(public_only)[:100]}...")

    if args.dry_run:
        print("\n[DRY RUN] nothing written. The private key just generated is discarded.")
        return 0

    try:
        import boto3
        from botocore.exceptions import ClientError
    except ImportError:
        sys.exit("Error: boto3 is required. pip install -r scripts/requirements.txt")

    client = boto3.client("secretsmanager", region_name=args.region)
    description = (
        f"Smile CDR keystores.json seed. Contains the private JWK for the "
        f"'{KEYSTORE_ID}' keystore used to sign OIDC tokens. Mounted over "
        f"{SEED_PATH} by the Secrets Store CSI driver. Generated by "
        f"scripts/generate_token_signing_keystore.py."
    )

    try:
        client.create_secret(Name=args.secret_name, SecretString=payload, Description=description)
        print(f"\nCreated secret {args.secret_name}")
    except ClientError as e:
        if e.response["Error"]["Code"] != "ResourceExistsException":
            raise
        if not args.rotate:
            print(f"\nSecret {args.secret_name} already exists. Not touching it.")
            print("Re-run with --rotate to replace the key deliberately. Doing so invalidates")
            print("every token signed by the current key and forces clients to re-fetch the JWKS.")
            return 1
        client.put_secret_value(SecretId=args.secret_name, SecretString=payload)
        print(f"\nROTATED secret {args.secret_name}. Restart the Smile CDR pods to pick it up.")

    print("\nNext: ensure the deployment mounts this secret (secrets.tokenSigningKeystore in")
    print("module-config/values-sparkey.yaml) and that the IRSA role can read it")
    print("(terraform/iam-users-secret.tf).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
