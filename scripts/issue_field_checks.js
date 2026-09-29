// Format checks for values read from issue form bodies.
//
// The issue workflows (issue-opened.yml, issue-labeled.yml) parse free text
// out of issue forms and hand it to scripts, git and the GitHub API. Each
// check below states the shape a legitimate value has, so a stray paste (a
// sentence in the version field, a second line under a single-line input)
// stops the run with a message that names the field instead of failing later
// inside a script or producing a malformed branch, file or PR.
//
// Every function returns an array of human-readable error lines ("" fields
// that are optional and empty produce no error). Loaded from github-script
// with:
//
//   const checks = require(`${process.env.GITHUB_WORKSPACE}/scripts/issue_field_checks.js`);

'use strict';

// FHIR package ids, e.g. hl7.fhir.au.core, hl7.fhir.uv.smart-app-launch.
const PACKAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// Package versions, e.g. 2.0.1, 3.0.0-ballot1, 6.1.1-draft, 1.0.0+build.
const VERSION = /^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/;
// One https URL with no whitespace, quotes or backslashes.
const HTTPS_URL = /^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?(\/[^\s"'`<>\\]*)?$/;
// Redirect URIs may be http (localhost during development) or https. Commas
// are excluded because the list is handed on comma-separated.
const REDIRECT_URI = /^https?:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?(\/[^\s,"'`<>\\]*)?$/;
// Single-line display text: no control characters (so no newlines).
const SINGLE_LINE = /^[^\x00-\x1f\x7f]{1,200}$/;
// Atomio feed names, e.g. hl7au-dev, reference.
const FEED_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// Comma-separated versions, spaces allowed around the commas.
const VERSION_LIST = /^[A-Za-z0-9.+-]+(\s*,\s*[A-Za-z0-9.+-]+)*$/;
// OAuth client ids, e.g. patient-dashboard, connectathon-app-01.
const CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// Space-separated SMART scopes, including v2 forms such as
// patient/Observation.rs?category=http://loinc.org|1234-5.
const SCOPES = /^[A-Za-z0-9/*._:?=&|%+-]+([ \t]+[A-Za-z0-9/*._:?=&|%+-]+)*$/;
const EMAIL = /^[^\s@"'`<>\\,;]+@[^\s@"'`<>\\,;]+\.[^\s@"'`<>\\,;]+$/;

const TX_ACTION_TYPES = ['Add new package watch', 'Remove package watch', 'Modify existing watch'];
const TX_VERSION_MODES = ['latest', 'all', 'pinned'];
const SMART_CLIENT_TYPES = ['SMART App Launch', 'Backend Service'];

function check(errors, value, pattern, message) {
  if (value && !pattern.test(value)) errors.push(message);
}

// IG release request (01-ig-release-request.yml).
function checkIgRequest({ igName, igVersion, packageId, packageUrl }) {
  const errors = [];
  check(errors, igName, SINGLE_LINE,
    'Implementation Guide Name must be a single line of at most 200 characters');
  check(errors, igVersion, VERSION,
    'IG Version must be a package version such as 3.0.0 or 1.2.0-ballot (letters, digits, ".", "-", "+")');
  check(errors, packageId, PACKAGE_ID,
    'NPM Package ID must be a package id such as hl7.fhir.uv.ips (letters, digits, ".", "-", "_")');
  check(errors, packageUrl, HTTPS_URL,
    'Custom Package URL must be a single https:// URL');
  return errors;
}

// Terminology server content change (04-tx-content-change.yml).
function checkTxRequest({ actionType, packageId, packageListUrl, displayName, versionMode, pinnedVersions, feedName }) {
  const errors = [];
  if (actionType && !TX_ACTION_TYPES.includes(actionType)) {
    errors.push(`Action Type must be one of: ${TX_ACTION_TYPES.join(', ')}`);
  }
  check(errors, packageId, PACKAGE_ID,
    'Package ID must be a package id such as hl7.fhir.au.base (letters, digits, ".", "-", "_")');
  check(errors, packageListUrl, HTTPS_URL,
    'Package List URL must be a single https:// URL');
  check(errors, displayName, SINGLE_LINE,
    'Display Name must be a single line of at most 200 characters');
  if (versionMode && !TX_VERSION_MODES.includes(versionMode)) {
    errors.push(`Version Mode must be one of: ${TX_VERSION_MODES.join(', ')}`);
  }
  check(errors, pinnedVersions, VERSION_LIST,
    'Pinned Versions must be a comma-separated list of versions such as 6.0.0, 5.0.0');
  check(errors, feedName, FEED_NAME,
    'Feed Name must be a feed name such as hl7au-dev (letters, digits, ".", "-", "_")');
  return errors;
}

// SMART client registration (05-smart-app-registration.yml). Redirect URIs
// are checked only for SMART App Launch clients; a Backend Service client does
// not use them.
function checkSmartClient({ clientId, clientName, clientType, redirectUris, scopes, contactEmail }) {
  const errors = [];
  check(errors, clientId, CLIENT_ID,
    'Client ID must be letters, digits, ".", "-" and "_" only, for example my-smart-app');
  check(errors, clientName, SINGLE_LINE,
    'Client Name must be a single line of at most 200 characters');
  if (clientType && !SMART_CLIENT_TYPES.includes(clientType)) {
    errors.push(`Client Type must be one of: ${SMART_CLIENT_TYPES.join(', ')}`);
  }
  if (clientType === 'SMART App Launch' && redirectUris) {
    const bad = redirectUris.split('\n').map(s => s.trim()).filter(s => s && !REDIRECT_URI.test(s));
    if (bad.length) errors.push('Redirect URIs must be one http:// or https:// URL per line');
  }
  check(errors, scopes, SCOPES,
    'Scopes must be a space-separated list of scopes such as launch/patient patient/*.read openid');
  check(errors, contactEmail, EMAIL,
    'Contact Email must be a single email address');
  return errors;
}

module.exports = { checkIgRequest, checkTxRequest, checkSmartClient };
