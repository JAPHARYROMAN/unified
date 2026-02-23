# Governance Evidence Bundle

This directory holds immutable evidence collected during governance drills and live incidents.

---

## Directory Structure

```
governance/evidence/
├── README.md                        ← this file
└── <DRILL_ID or INCIDENT_ID>/       ← one sub-directory per event
    ├── 00-preflight.json            ← environment health baseline
    ├── 01-soft-halt.json            ← Drill 1 / soft-halt evidence
    ├── 02-onchain-pause.json        ← Drill 2 / hard-pause evidence
    ├── 03-signer-rotation.json      ← Drill 3 / signer rotation evidence
    ├── 04-partner-disable.json      ← Drill 4 / partner disablement evidence
    ├── 05-recovery.json             ← Drill 5 / recovery evidence
    ├── decision-checklist.md        ← completed DECISION_CHECKLIST template
    ├── drill-log.md                 ← completed DRILL_LOG template
    └── postmortem.md                ← completed POSTMORTEM template (if incident)
```

ID format: `DRILL-YYYYMMDD-NNN` (drills) or `INC-YYYYMMDD-NNN` (live incidents).

---

## Evidence JSON Schema

Every evidence file written by the drill scripts follows this envelope:

```jsonc
{
  "drillId":     "DRILL-20260223-001",   // DRILL_ID env var
  "drillName":   "01-soft-halt",         // script name
  "operator":    "alice",                // DRILL_OPERATOR_ID env var
  "generatedAt": "2026-02-23T10:00:00Z", // ISO-8601 UTC
  "steps": [
    {
      "step":      "fire_drill_trigger",
      "timestamp": "2026-02-23T10:00:01Z",
      "data": { /* arbitrary key/value pairs captured at this step */ }
    }
  ]
}
```

---

## Generating an Evidence Bundle

### 1. Set environment variables

```bash
export DRILL_API_URL=http://localhost:3000
export DRILL_ADMIN_KEY=<admin-api-key>
export DRILL_OPERATOR_ID=<your-name>
export DRILL_ID=DRILL-$(date -u +%Y%m%d)-001
```

### 2. Run the preflight check

```bash
npx ts-node governance/scripts/00-preflight.ts
```

Confirm the output shows `PREFLIGHT PASSED` before continuing.

### 3. Run each drill script in sequence

```bash
npx ts-node governance/scripts/01-soft-halt.ts
npx ts-node governance/scripts/02-onchain-pause.ts   # see RUNBOOK.md §2 for Hardhat steps
npx ts-node governance/scripts/03-signer-rotation.ts # see RUNBOOK.md §3 for Hardhat steps
npx ts-node governance/scripts/04-partner-disable.ts
npx ts-node governance/scripts/05-recovery.ts
```

### 4. Verify evidence files

After all scripts complete, confirm each expected file exists:

```bash
ls governance/evidence/$DRILL_ID/
# Expected:
# 00-preflight.json  01-soft-halt.json  02-onchain-pause.json
# 03-signer-rotation.json  04-partner-disable.json  05-recovery.json
```

### 5. Complete the paper templates

Copy and fill in:

| Template | Destination |
|----------|-------------|
| `governance/templates/DECISION_CHECKLIST.md` | `governance/evidence/<ID>/decision-checklist.md` |
| `governance/templates/DRILL_LOG.md` | `governance/evidence/<ID>/drill-log.md` |
| `governance/templates/POSTMORTEM_TEMPLATE.md` | `governance/evidence/<ID>/postmortem.md` *(incidents only)* |

---

## Integrity and Retention

- **Do not modify** JSON evidence files after they are written. They are the authoritative record of what happened.
- Evidence bundles must be retained for **at least 7 years** in accordance with the risk/compliance policy.
- For live incidents, copy the entire `<INCIDENT_ID>/` sub-directory to the secure evidence archive (S3 bucket / shared drive) before deleting staging state.
- Every JSON file is written atomically by the drill scripts (`fs.writeFileSync` with a fully-constructed object) — partial writes indicate an aborted run and should be treated as incomplete evidence.

---

## Checklist: Evidence Bundle Complete?

Before closing a drill or incident record, confirm all of the following:

- [ ] `00-preflight.json` present and shows `allPassed: true`
- [ ] All executed drill JSON files present
- [ ] Each JSON file contains a non-empty `steps` array
- [ ] `decision-checklist.md` filled in and signed
- [ ] `drill-log.md` filled in with overall PASS / FAIL and sign-offs
- [ ] `postmortem.md` filled in and status is FINAL *(live incidents only)*
- [ ] Bundle copied to secure evidence archive
- [ ] Governance incident record updated with bundle location

---

*This directory is tracked in version control for structural reference only.*
*Actual evidence bundles for live incidents must also be stored in the secure off-repo archive.*
