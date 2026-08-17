# Cleanup policy

1. Never clean a repository while Actions is running or queued.
2. Safe auto-cleanup only runs when repository cleanup pressure is above the configured threshold.
3. Protected artifact families are preserved.
4. Ephemeral artifacts must be at least 7 days old; generic duplicate artifacts must be at least 30 days old and have a newer same-name copy.
5. Cache safe-cleanup starts only above 80% of the 10 GB default cache limit and aims toward 60%.
6. A full cache purge is manual-only and requires an exact confirmation phrase.
7. Workflow run history and logs are never deleted.
8. Every cleanup writes a JSONL audit record under `~/.github-control-center/cleanup-log.jsonl`.
