# Security Policy

## Reporting Vulnerabilities

If you discover a security vulnerability in this repository, please report it responsibly:

- **Do NOT** create a public GitHub issue for security vulnerabilities
- Email the team at the contact listed in the repository settings
- We will acknowledge your report within 48 hours

## Scope

This repository contains Infrastructure-as-Code configuration for the Sparked FHIR Server. Actual credentials and secrets are managed externally via:

- AWS Secrets Manager
- GitHub Actions Secrets and Variables
- Terraform variable files (not committed to the repository)

## Security Practices

- All sensitive values are externalized to environment-specific configuration
- GitHub Actions workflows are restricted to prevent execution from forked repositories
- Branch protection rules require review from AEHRC team members for changes
- CODEOWNERS enforces review requirements for infrastructure and workflow changes
