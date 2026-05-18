# Onboarding Rollout Playbook

## Purpose

Safely roll out enterprise onboarding and migration without impacting existing live tenants.

## Feature Flags

Company-level flags in `Company`:

- `onboardingEnabled`: enables onboarding APIs/UI for the tenant.
- `onboardingStrictValidation`: forces strict import validation in operational playbooks.
- `onboardingKillSwitch`: emergency stop for all onboarding operations.
- `onboardingPilotCohort`: cohort label for staged releases.

## Pilot Sequence

1. Enable `onboardingEnabled=true` for one internal pilot tenant.
2. Keep `onboardingStrictValidation=true` in pilot.
3. Run dry-run imports first (`mode=DRY_RUN`) for all entities.
4. Review `/onboarding/reconciliations` and `/onboarding/ops/summary`.
5. Run commit imports in sequence:
   - master data
   - opening stock
   - opening balances
   - optional historical archive
6. Verify reconciliation status is `MATCHED` or approved.
7. Trigger `/onboarding/go-live`.

## Rollback Controls

- Endpoint: `POST /api/v1/onboarding/imports/:id/rollback`
- Permission: `onboarding.rollback`
- Supported rollback:
  - master data imports (`products`, `pharmacies`, `distributors`, `employees`) via soft-delete
  - opening stock (zero-out imported inventory rows)
  - opening balances (soft-delete imported ledger rows)

## Monitoring Checklist

- `GET /api/v1/onboarding/ops/summary`
  - job status distribution
  - recent failed jobs
  - reconciliation alerts count
- `GET /api/v1/onboarding/imports`
  - track queue backlogs / failure trends by entity type
- `GET /api/v1/onboarding/reconciliations`
  - must resolve `MISMATCHED` / `REVIEW_REQUIRED` before go-live

## Emergency Procedure

1. Set `onboardingKillSwitch=true` on impacted tenant(s).
2. Stop further imports and communicate freeze.
3. Review latest `ROLLBACK_COMPLETED` and `IMPORT_FAILED` audit events.
4. Execute targeted rollback jobs if needed.
5. Re-enable only after reconciliation returns to expected state.
