# GitHub Control Center

A private, local-first dashboard for monitoring GitHub repository storage and Actions pressure across all repositories owned by the authenticated `gh` account.

## What it shows

- Repository size
- GitHub Actions cache usage and the default 10 GB repository cache limit
- Live Actions artifacts and their size
- Running and queued workflow runs
- Workflow/run counts and recent failures
- A derived Cleanup Pressure score
- Direct links to Repository, Actions, Cache, Workflows, and Actions Settings
- Account billing/storage allowance when the current `gh` authentication is allowed to read it; otherwise it explicitly reports unknown rather than guessing

## Cleanup safety

- A repository with a running or queued workflow is never cleaned.
- Safe cleanup previews candidates before deletion.
- Protected artifact families (release/final/evidence/audit/delivery/product/governance/snapshot) are preserved.
- Old duplicate artifacts and clearly ephemeral artifacts are candidates.
- Cache cleanup is pressure-based: above 80%, safe cleanup removes older caches toward 60%, while trying to preserve recent family copies.
- Full cache purge is available per repository, but requires explicit `DELETE owner/repo` confirmation.
- Workflow runs and logs are never deleted.
- Automatic cleanup is local, optional, and defaults OFF. It only uses Safe Cleanup and only when pressure is above the configured threshold.

## Start

Requirements: Node.js 22+ and authenticated GitHub CLI (`gh auth status`).

```bash
npm start
```

Open: `http://127.0.0.1:3010`

## Create the private GitHub repository

From this folder:

```bash
./scripts/create-private-repo.sh
```

This creates `Shahbazi-Amir/GitHub-Control-Center` as a **private** repository and pushes the source. Pass another `owner/name` as the first argument to change the target.

## Optional: run automatically on macOS login

```bash
./scripts/install-launch-agent.sh
```

The server binds only to `127.0.0.1`, so it is not exposed to the LAN by default.
