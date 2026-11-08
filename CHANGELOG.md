# Changelog

## 1.0.2

- Setup now explains how to get a PushPlus token (https://www.pushplus.plus/).
- README adds token onboarding steps.
- Missing-token log points at the setup command and token URL.

## 1.0.1

- Standard DSH bundle layout (`dsh.bundle.patch`).
- One package-level `cordis.patch.yml`; no per-profile hand editing.
- User settings decoupled into `$DSH_HOME/pushplus-notify.json`.
- Added `setup`, `test`, and `status` CLI commands.
- Completion / error / abort / blocked / max-tokens / approval / `ask_user_question` notifications.
- Startup notification once per DSH process.
- Retry and HTTP fallback for PushPlus.
- 18 offline tests.

## 1.0.0

- Initial bundle conversion.
