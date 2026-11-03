# Security Policy

cmd-sync-servers moves files between your machine and your servers with your
credentials, so security reports are welcome and taken seriously.

## Supported Versions

Only the latest release receives security fixes. Update to it before
reporting, and say so if the problem is still there.

| Version | Supported |
| --- | --- |
| Latest `1.x` release | Yes |
| Earlier releases, including the `1.0.0-alpha` pre-releases | No |

## Reporting a Vulnerability

Report privately through GitHub's private vulnerability reporting:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability**.
3. Fill in the form.

The direct link is
<https://github.com/isocialPractice/cmd-sync-servers/security/advisories/new>.

**Never open a public issue, discussion or pull request for a
vulnerability.** A public report puts every user at risk before a fix exists.

## What to Include

- The version (`sync-servers --version`), the operating system and the
  Node.js version (`node --version`)
- The protocol involved (SFTP, FTPS, FTP or local folder), if any
- The steps that reproduce the problem, and what happened compared with
  what should have happened
- The impact as you understand it: what an attacker could read, change or
  delete, and from where
- A proof of concept, if you have one

Do not include real passwords, private keys, host names or other people's
data. Use placeholders such as `sftp.example.com` and `demo-user`, and
generate throwaway keys for any proof of concept.

## What to Expect

- An acknowledgement within 7 days.
- An assessment, with a severity and a plan, within 14 days.
- Progress updates in the private advisory until the issue is resolved.
- A fix released as a new patch version, then a published GitHub security advisory
  that credits you, unless you ask not to be named.

Please give the fix a chance to ship before disclosing details publicly.
Coordinated disclosure dates can be agreed in the advisory.

## Verifying a Release

Every release is built from its tag by `.github/workflows/release.yml` and
carries the package tarball, a CycloneDX SBOM, a Sigstore attestation bundle
and `SHA256SUMS`. Check a download with:

```sh
sha256sum --check --ignore-missing SHA256SUMS
gh attestation verify isocialpractice-cmd-sync-servers-<version>.tgz --repo isocialPractice/cmd-sync-servers \
  --signer-workflow isocialPractice/cmd-sync-servers/.github/workflows/release.yml
```

Packages on npm are published by the same workflow with npm trusted
publishing and carry provenance; `npm audit signatures` checks it.

## Scope

In scope:

- The `@isocialpractice/cmd-sync-servers` package: the `sync-servers`
  command and the library API
- The GitHub Actions workflows and release artifacts of this repository

Out of scope:

- The VS Code extension, which has its own repository and security policy
- Vulnerabilities in Node.js, the operating system, or the servers you
  connect to
- Attacks that already require control of your user account
