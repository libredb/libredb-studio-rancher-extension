# Security Policy

## Supported Versions

Security fixes are released against the latest published release only.
There is no long-term support branch and no backport policy: if you run an older version, the upgrade path to a fix is the current release.
The releases page is the authority on what that currently is: <https://github.com/libredb/libredb-studio-rancher-extension/releases>

## Known Risks

These follow from how the extension works and are not vulnerabilities to report.

| Risk | Where | What limits it |
| --- | --- | --- |
| Owners of the cluster that runs LibreDB Studio can act in Rancher as any user who signs in to LibreDB Studio | Single sign-on through Rancher, which is experimental | The setup and the Settings page turn single sign-on on only after a Rancher administrator acknowledges this risk; without single sign-on LibreDB Studio keeps its own sign-in. Enable it only on clusters whose owners you trust that far. A Rancher administrator can turn it off again on the Settings page, which upgrades LibreDB Studio to its own sign-in and deletes the OIDC client. |
| The OIDC client secret sits in LibreDB Studio's own Secret, which owners of its cluster can read | Single sign-on through Rancher | The secret is never in chart values or the Apps form, and the extension never shows it. A Rancher administrator rotates it on the Settings page, for example when an owner of that cluster leaves: Rancher generates a new secret for the annotation `cattle.io/oidc-client-secret-regenerate: client-secret-1` on the OIDCClient `libredb-studio-<cluster id>`, the extension writes it under `oidc-client-secret` into the Secret `libredb-studio-oidc` in the `libredb-studio` namespace, and restarts the `libredb-studio` Deployment. The old secret stops working at once, so a sign-in during the restart fails. Turning single sign-on off deletes the OIDC client and that Secret. |

## Reporting a Vulnerability

Please do not report security vulnerabilities through public GitHub issues.
Report them by email to info@sekoya.tech, or through a private vulnerability report on this repository.
Reports are handled by SEKOYA GRUP BİLİŞİM VE TEKNOLOJİ LİMİTED ŞİRKETİ, the maintainer of LibreDB Studio and of this extension.

Please include the type of issue, the affected version or commit, the Rancher version, step-by-step instructions to reproduce it, and its impact.

## What to Expect

- Acknowledgment within 48 hours.
- An initial assessment within 7 days.
- A fix for a critical vulnerability released within 14 days from the assessment.
- Progress updates every 7 to 10 days until the issue is resolved.
- Serious defects are named in the release notes of the release that fixes them.

## Disclosure Policy

We coordinate with the reporter to fix a vulnerability before public disclosure, and credit the reporter unless they prefer to remain anonymous.
We will not take legal action against security researchers who act in good faith, do not access more data than necessary, do not modify or delete data, and do not disrupt our services.

A vulnerability in LibreDB Studio itself is reported the same way and handled under the policy of <https://github.com/libredb/libredb-studio/blob/main/SECURITY.md>.
