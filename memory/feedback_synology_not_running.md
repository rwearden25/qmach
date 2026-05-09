---
name: Synology NAS is not actively running
description: Don't propose the Synology as a live target for cron jobs, backup pulls, or services without confirming it's powered on
type: feedback
---

The synology-homelab skill loads context about the user's DS3622xs+/DS3612xs and the homelab, but the NAS is not always powered on. When recommending a place for a cron job, an offsite backup pull, a Telegram bot host, or any other "second machine" role, **do not default to the Synology**.

**Why:** User pushed back when I suggested running an offsite-backup cron on the Synology — said "I do not even have it powered on." Treating the homelab skill's content as live infrastructure produces irrelevant recommendations.

**How to apply:** When a task needs a second machine or always-on host, ask which environment is appropriate (cloud object storage, GitHub Actions cron, Railway sidecar, a different always-on machine, etc.) rather than assuming the Synology. If the user later confirms it's running for a specific project, treat that as project-scoped, not a general default.
