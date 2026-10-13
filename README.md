# gh-backup

A personal, self-hosted backup of your GitHub repositories that runs entirely in your own Cloudflare account.

If GitHub suspends your account tomorrow, you still have every branch, tag, pull request head, issue, review, release and LFS object, and you can `git clone` all of it straight from Cloudflare.

> **Status: untested against live services.** The git mirroring logic, crypto and dashboard are covered by local tests, but this has not yet been deployed end to end against real Cloudflare Artifacts and a real GitHub App. Both Artifacts and the `cf` CLI are in beta. Expect to fix things on the first deploy; see [Known unknowns](#known-unknowns).

## What gets backed up

| What | Where it goes |
| --- | --- |
| Full git history: all branches, tags and pull request heads | [Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/), one repo per GitHub repo |
| Wikis | Artifacts, as `<repo>.wiki` |
| Git LFS objects (all history, not just current files) | R2, content-addressed under `lfs/` |
| Issues, pull requests, reviews, comments, labels, milestones | R2, one JSON file per item under `meta/<owner>/<repo>/` |
| Releases and their downloadable assets | R2, same prefix |
| Repos too big for Artifacts (over 1 GB, or any file over 32 MB) | R2, as complete `git bundle` files (newest 3 kept) |

## It never mirrors destruction

A plain mirror would copy a force-push or a deleted branch and destroy the very history you wanted to keep. This does not:

- **Force-pushed branches and moved tags**: the old commit is kept under `refs/backup/rewritten/<timestamp>/…` before the branch is updated.
- **Deleted branches and tags**: moved to `refs/backup/deleted/<timestamp>/…`.
- **Repos that vanish from GitHub** (deleted, access revoked, or your account banned): marked "gone from GitHub · kept". The backup is frozen and nothing is ever deleted automatically.
- **GitHub refusing the app entirely**: the dashboard shows a banner with the date it started, and every backup stays as it was.

## Choosing what to back up

Out of the box only your own non-fork repositories are backed up. Everything else is a toggle in the dashboard:

- **Per account and per organization**: "Back up" on/off and "Include forks" on/off, set separately for each one.
- **Per repository**: "Follow account", "Always back up" or "Never back up". This is how you back up one fork or one org repo without taking the rest.
- **Starred repositories**: one switch, off by default. Public repos only, git history only.

## Requirements

- A Cloudflare account on the **Workers Paid** plan (Artifacts and Containers both need it).
- **Docker** running locally when you deploy, to build the small git container image.
- **Node.js 22.18+** and the Cloudflare CLI: `npm install --global cf`.

## Deploy

```sh
git clone <this repo> && cd gh-backup
npm install
cf auth login
cf deploy
```

`cf deploy` creates the D1 database, the R2 bucket and the container, and prints your Worker URL. The Artifacts namespace is created on first use.

Then open the Worker URL:

1. Click **Create the GitHub App**. GitHub shows a pre-filled app that can only *read* contents, metadata, issues and pull requests. Confirm it.
2. Choose where to install it: your account, any organizations, all or selected repositories.
3. You land on the dashboard and the first backup starts.

Do step 1 right after deploying: whoever completes it becomes the owner of the deployment.

To add an organization later, use **Add account or org** in the dashboard, then switch that organization on.

## How it works

```
cron (every 6 h) ─┐
push webhook ─────┼─▶ Worker ─▶ Workflow (one per repo) ─▶ Container: git fetch + git push ─▶ Artifacts
dashboard ────────┘                      │
                                         ├─▶ GitHub LFS API ─▶ R2
                                         └─▶ GitHub REST API ─▶ R2 (issues, PRs, releases…)
```

- **Worker** (`src/index.ts`): dashboard, GitHub App setup and sign-in, webhook receiver, cron.
- **Workflow** (`src/workflow.ts`): one durable, retried run per repository. Skips the git step when nothing was pushed since the last sync.
- **Container** (`container/`): Alpine, git and about 300 lines of Node. It fetches the existing backup from Artifacts, fetches from GitHub on top, snapshots anything that was rewritten or deleted, and pushes the result. Credentials are passed through the environment, never the command line.
- **D1**: settings, the repo list and run history. **R2**: everything that is not git.

Syncs run on every push (bursts collapse into one per two minutes), every 6 hours for anything that changed, and at least daily for metadata. Change the schedule in `cloudflare.config.ts`.

## Restoring

Open a repository in the dashboard and click **Create a 1-hour clone token**. You get a ready-to-paste command:

```sh
git clone --mirror https://x:<token>@<account>.artifacts.cloudflare.net/git/gh-backup/<owner>--<repo>.git
```

To move the repo to a new home:

```sh
cd <owner>--<repo>.git
git push --mirror <new remote>
```

`--mirror` matters: a normal clone only takes branches and tags, and would leave `refs/pull/*` and `refs/backup/*` behind.

Everything else is plain files in the R2 bucket `gh-backup-data`:

- `meta/<owner>/<repo>/issues/<number>.json` and friends are the raw GitHub API objects.
- `lfs-manifests/<repo id>.json` lists a repo's LFS objects; each one is at `lfs/<first two hex chars>/<oid>`. To restore, copy them into `.git/lfs/objects/<aa>/<bb>/<oid>` of a clone and run `git lfs checkout`.
- `bundles/<repo id>/<timestamp>.bundle` restores with `git clone --mirror <file>`.

## Security notes

- The GitHub App is read-only and its private key lives in your D1 database, inside your Cloudflare account.
- Only the GitHub user who created the app can sign in to the dashboard.
- The app is created as *public* because GitHub only allows private apps to be installed on the account that owns them, which would rule out organizations. If a stranger installs it, their account appears in your dashboard switched off and nothing of theirs is backed up unless you turn it on.
- To start over, delete the rows in the `config` table (`cf d1 query <database id> --sql "DELETE FROM config"`) and delete the app on GitHub.

## Cost

You pay Cloudflare directly: Workers Paid ($5/month), plus Artifacts storage and operations, R2 storage and container run time beyond their included amounts. For a typical personal account (a few hundred small repos) the git container runs for seconds per changed repo. Check current pricing for [Artifacts](https://developers.cloudflare.com/artifacts/platform/pricing/), [R2](https://developers.cloudflare.com/r2/pricing/) and [Containers](https://developers.cloudflare.com/containers/pricing/).

## Development

```sh
npm test            # git mirroring scenarios against local repos, plus crypto
npm run typecheck
cf dev              # needs Docker
GH_BACKUP_NO_CONTAINER=1 cf dev   # dashboard only, no Docker
```

## Known unknowns

Things the Artifacts docs do not spell out, which the first real deploy will settle:

- Whether Artifacts accepts pushes to custom ref namespaces (`refs/backup/*`, `refs/pull/*`). If not, the namespace in `container/sync.mjs` needs to move under `refs/heads/`.
- Whether Artifacts accepts ref deletions and non-fast-forward updates over git push. The sync already tolerates refused deletions.
- Whether very large first pushes need `http.postBuffer` tuning.
- Metadata for repos with tens of thousands of issues may exceed the default Workflow step budget on the first run; later runs are incremental.
- Artifacts repo names are capped at 56 characters here as a guess; longer `owner/repo` names are truncated and suffixed with the repo id.

## License

MIT
