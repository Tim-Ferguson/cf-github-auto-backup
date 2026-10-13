# gh-backup

A personal, self-hosted backup of your GitHub repositories that runs entirely in your own Cloudflare account.

If GitHub suspends your account tomorrow, you still have every branch, tag, pull request head, issue, review, release and LFS object, and you can `git clone` all of it straight from Cloudflare.

> **Status: early, but working.** A first live run backed up 60 repositories into Cloudflare Artifacts, and every branch and pull request head was verified identical to GitHub. Several features have not run against live services yet; see [Testing status](#testing-status) for what is confirmed and what you can help test. Artifacts and the `cf` CLI are both in beta.

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
- **Docker** (Docker Desktop, or Colima with the `docker-buildx` plugin) running locally when you deploy from your terminal. The one-click button builds in Cloudflare instead.
- **Node.js 22.18+**. The Cloudflare CLI (`cf`) is installed with the project.
- Optional: the [GitHub CLI](https://cli.github.com/) if you want to connect GitHub with its token.

## Deploy

### One click

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Tim-Ferguson/cf-github-auto-backup)

Cloudflare copies this repo into your account, asks you for an `ADMIN_PASSWORD`, and builds and deploys everything. Then open the Worker URL, enter the password, click **Create the GitHub App**, and choose what to bring in.

> The button has not been confirmed end to end yet (see [Testing status](#testing-status)). If it fails, use the CLI below, which is tested against a live account.

### From your terminal

```sh
git clone https://github.com/Tim-Ferguson/cf-github-auto-backup && cd cf-github-auto-backup
npm install
npm run cli
```

The CLI walks you through everything and then becomes your control panel:

1. **Checks this machine**: Node, Docker, the `cf` CLI.
2. **Cloudflare**: signs you in with the browser (`cf auth login`), or takes an API token and account ID and saves them to a git-ignored `.env`. If `CLOUDFLARE_API_TOKEN` is already set, it just uses it.
3. **Password**: generates one or takes yours, and saves it to a git-ignored `.gh-backup.json`.
4. **Deploys** the Worker, D1 database, R2 bucket and container with `cf deploy`, uploading the password as a secret in the same step.
5. **GitHub**: pick one of the three ways below.
6. **What to back up**: switch organizations, forks and starred repos on or off.

### Locked until you set a password

The deployment is protected by the `ADMIN_PASSWORD` secret from its very first request. There is no window in which someone who finds the URL could claim it:

- **No password set** (or one shorter than 12 characters): every page answers "This deployment is locked". Nothing can be configured by anyone.
- **Password set**: connecting GitHub, the dashboard and the CLI all require it.
- **Forgot it?** Set a new `ADMIN_PASSWORD` under the Worker's **Settings → Variables and Secrets** in the Cloudflare dashboard.

Once the GitHub App exists you can also sign in with GitHub; only the account that created the app is let in.

### Connecting GitHub

| | GitHub App (recommended) | Token from `gh` | Pasted token |
| --- | --- | --- | --- |
| How | Finishes in the browser | Uses `gh auth token` (runs `gh auth login` if needed) | Paste a personal access token |
| Access | Read-only, only where you install it | Whatever your `gh` sign-in can do, including write | Whatever you grant; fine-grained read-only is best |
| Sync on push | Yes, by webhook | No, every 6 hours | No, every 6 hours |
| Dashboard sign-in | Password or GitHub | Password | Password |

A token is stored in your D1 database. You can start with a token and switch to a GitHub App later from the dashboard.

### Everyday commands

```sh
npm run cli                    # interactive menu
npm run cli -- status          # what is backed up, what is failing
npm run cli -- accounts        # toggle accounts, orgs, forks, single repos
npm run cli -- sync [repo]     # sync everything, or one repo
npm run cli -- discover        # refresh the repo list from GitHub
npm run cli -- clone [repo]    # print a ready-to-paste restore command
npm run cli -- open            # open the dashboard
```

To drive a deployment from another machine or from CI, set `GH_BACKUP_URL` and `GH_BACKUP_PASSWORD` instead of using `.gh-backup.json`.

### Plain `cf`

```sh
cf auth login
echo 'ADMIN_PASSWORD=<at least 12 characters>' > secrets.env
cf deploy --secrets-file secrets.env && rm secrets.env
```

Then open the Worker URL, sign in with the password and click **Create the GitHub App**. To add an organization later, use **Add account or org** in the dashboard, then switch that organization on.

## How it works

```
cron (every 6 h) ─┐
push webhook ─────┼─▶ Worker ─▶ Workflow (one per repo) ─▶ Container: git fetch + git push ─▶ Artifacts
dashboard ────────┘                      │
                                         ├─▶ GitHub LFS API ─▶ R2
                                         └─▶ GitHub REST API ─▶ R2 (issues, PRs, releases…)
```

- **Worker** (`src/index.ts`): dashboard, GitHub App setup and sign-in, webhook receiver, cron, and the JSON API the CLI talks to.
- **CLI** (`cli/gh-backup.mjs`): setup wizard and control panel. Plain Node, no dependencies.
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
- The dashboard, the setup page and the `/api/*` endpoints all require the `ADMIN_PASSWORD` secret; the GitHub account that created the app can also sign in with GitHub. Use a long random password, since the sign-in form is reachable from the internet, and keep `.gh-backup.json` private.
- In token mode the GitHub token sits in D1 in plain text and may carry write access. Prefer the GitHub App, or a fine-grained read-only token.
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

## Testing status

### Confirmed on a live deployment

One real run, on one personal account, set up with the CLI and a GitHub App:

- **Deploy from a terminal** with `npm run cli` (macOS, Colima with the `docker-buildx` plugin).
- **Password lock**: the right password signs in, a wrong one is refused, and the setup page is unreachable without it.
- **GitHub App setup** from the dashboard, then discovery of 60 owned non-fork repositories.
- **Full backup of all 60** into Artifacts with no failures, about 370 MB of git data. Empty repositories stay empty.
- **Every ref verified**: all 100 branches and 55 pull request heads (`refs/pull/*`) in Artifacts were compared with GitHub and matched.
- **Restore**: a repository cloned back from Cloudflare with the dashboard's clone command was complete and matched GitHub.
- **Metadata**: issues, pull requests, comments and labels were written to R2.

### Covered by local tests only

These work against local git repositories in `npm test` but have not run against real Artifacts yet:

- Keeping force-pushed history under `refs/backup/rewritten/`.
- Keeping deleted branches and tags under `refs/backup/deleted/`, including reuse of the name (`foo` deleted, `foo/bar` created).
- Detecting LFS pointers across all history.
- Falling back to a git bundle when a repo exceeds the Artifacts limits.
- Refusing to touch the backup when the source has vanished.

### Not tested at all: help wanted

If you try any of these, please open an issue with what happened, good or bad.

| What to try | How | What should happen |
| --- | --- | --- |
| **One-click deploy** | Click the Deploy to Cloudflare button above | Cloudflare asks for `ADMIN_PASSWORD`, builds the container and deploys. Unknown: whether the button accepts `cloudflare.config.ts` instead of a Wrangler config, and whether its build token can create the container and Artifacts resources. |
| **Force-push** | Force-push a branch in a backed-up repo, then sync | The old commit appears under `refs/backup/rewritten/<timestamp>/…` in a `--mirror` clone. Unknown: whether Artifacts accepts the `refs/backup/*` namespace and non-fast-forward updates. |
| **Deleted branch or tag** | Delete one on GitHub, then sync | It moves to `refs/backup/deleted/<timestamp>/…`. Unknown: whether Artifacts accepts ref deletions over push (the sync tolerates a refusal). |
| **Git LFS** | Back up a repo that uses LFS | Objects land in R2 under `lfs/`, listed in `lfs-manifests/<repo id>.json`. |
| **A large repo** | Back up one over 1 GB, or with a file over 32 MB | It is stored as `bundles/<repo id>/<timestamp>.bundle` in R2 and the dashboard marks it "bundle". |
| **A big first push** | Back up a repo of several hundred MB | It succeeds. Unknown: whether very large pushes need `http.postBuffer` tuning. |
| **Wikis** | Back up a repo with wiki pages | A second Artifacts repo named `<owner>--<repo>.wiki`, with its own clone command. |
| **Tags and releases** | Back up a repo with tags, releases and release assets | Tags are in the clone; releases and assets are under `meta/<owner>/<repo>/` in R2. |
| **Many issues** | Back up a repo with thousands of issues or pull requests | All are stored. Unknown: a first run with tens of thousands may exceed the default Workflow step budget; later runs are incremental. |
| **Organizations** | Install the app on an org and switch it on | Its repos are listed and backed up; nothing happens until you switch it on. |
| **Forks and single-repo overrides** | Turn on "Include forks", or set one repo to "Always" / "Never" | Only the selected repos change. |
| **Starred repositories** | Switch on "Starred repositories" | Your public stars are listed and their git history backed up. |
| **Token mode** | In the CLI, connect GitHub with the `gh` token or a pasted token instead of the app | Repos are discovered and backed up every 6 hours, with no push webhooks. |
| **Sync on push** | Push to a backed-up repo (GitHub App mode) | A sync starts within a couple of minutes, with trigger "push" in the repo's run list. |
| **Losing access** | Uninstall the app from an account, or remove a repo from it | The repos show "gone from GitHub · kept" and stay cloneable from Cloudflare. |
| **Long repo names** | Back up a repo whose `owner/repo` is longer than 56 characters | It works under a truncated Artifacts name. The 56-character cap is a guess at Artifacts' limit. |
| **Other platforms** | Deploy from Linux or Windows, or with Docker Desktop | The CLI has only been run on macOS with Colima. |

## License

MIT
