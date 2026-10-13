import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { ensureSchema, getAccount, getRepo, isBackedUp, type Repo, STARRED, updateRepo } from "./db.ts";
import { gitBasicAuth, loadDeployment, tokenFor } from "./github.ts";
import { META_VERSION, type PageResult, regroupFlatComments, RESOURCES, syncMetadataPage } from "./metadata.ts";
import { type GitRunner, runnerFor } from "./runner.ts";
import { copyLfsObjects, latestBundle, type LfsObject, lfsManifestKey, lfsPendingKey, metaPrefix, pruneBundles, putRanged } from "./storage.ts";

export interface BackupParams {
	repoId: number;
	trigger: string;
	force: boolean;
}

// Artifacts limits: https://developers.cloudflare.com/artifacts/platform/limits/
// Repos beyond them are stored as git bundles in R2 instead.
const MAX_BLOB_BYTES = 32 * 1024 ** 2;
const MAX_REPO_BYTES = 1024 ** 3;

// Poll quickly at first, then back off so long clones stay well inside the
// per-instance step budget. 250 polls cover a little under four hours.
const MAX_POLLS = 250;
const pollSeconds = (i: number) => (i < 6 ? 5 : i < 30 ? 15 : 60);
const LFS_BATCH = 20;
// Longer than the longest sync the poll loop allows, so a second sync cannot
// start while the first may still be using the container.
const RUNNING_GRACE_MS = 5 * 60 * 60 * 1000;
const BUSY = "another sync of this repository is still running";
const ARTIFACTS_TOKEN_TTL = 6 * 60 * 60;
const MAX_META_PAGES = 2000;
const MAX_RATE_LIMIT_WAITS = 8;

interface GitResult {
	refs: { heads: number; tags: number; pulls: number; snapshots: number };
	updated: number;
	deleted: number;
	deleteFailures: number;
	newSnapshots: string[];
	sizeBytes: number;
	oversize: string | null;
	bundle: { size: number } | null;
	/** With `incremental`, only the pointers found in newly fetched objects. */
	lfs: { count: number; bytes: number; size: number; incremental?: boolean };
	/** "incremental" moved only new objects; "full" downloaded the backup first. */
	mode?: "incremental" | "full";
	transferredBytes?: number;
	/** Why an incremental sync was abandoned for a full one. */
	fallback?: string;
}

interface RunnerStatus {
	id?: string;
	state: "idle" | "running" | "done" | "error";
	phase?: string;
	result?: GitResult;
	error?: { code: string; message: string };
}

interface GitJob {
	label: string;
	jobId: string;
	sourcePath: string;
	artifactsName: string;
	description: string;
	defaultBranch: string | null;
	pulls: boolean;
	/** Missing sources are expected for wikis that were never created. */
	optional: boolean;
	/** R2 key of a bundle that holds the existing backup, for repos too large for Artifacts. */
	seedBundle: string | null;
	/** GitHub API base for this repo, used to tell a fast-forward from a rewrite. */
	api: string | null;
	/** Size of the backup so far, so growth past the target's limit is noticed. */
	knownSizeBytes: number;
}

/**
 * Artifacts names allow letters, digits, dots, underscores and hyphens. The
 * repo id is part of the name because `owner/repo` can be renamed and later
 * reused by a different repository, which must not share a backup.
 */
export function artifactsName(repo: Pick<Repo, "id" | "full_name">): string {
	const name = repo.full_name.replace("/", "--").replace(/[^A-Za-z0-9._-]/g, "-");
	const suffix = `-${repo.id}`;
	return name.slice(0, 50 - suffix.length) + suffix;
}

const cursorNow = () => new Date().toISOString().slice(0, 19) + "Z";

export class BackupWorkflow extends WorkflowEntrypoint<Env, BackupParams> {
	async run(event: Readonly<WorkflowEvent<BackupParams>>, step: WorkflowStep) {
		const { repoId, trigger, force } = event.payload;
		const env = this.env;

		const plan = await step.do("load", async () => {
			await ensureSchema(env.DB);
			const repo = await getRepo(env.DB, repoId);
			if (!repo) return null;
			const account = await getAccount(env.DB, repo.account);
			if (!force && !isBackedUp(repo, account ?? undefined)) return null;
			// Two syncs of one repo would fight over the same container. A retry
			// of this very step is recognised by its instance id and carries on.
			const mine = repo.run_instance === event.instanceId;
			if (!mine && repo.last_status === "running" && repo.last_run_at && Date.now() - Date.parse(repo.last_run_at) < RUNNING_GRACE_MS) return null;

			const startedAt = mine && repo.last_run_at ? repo.last_run_at : cursorNow();
			const name = repo.artifacts_name ?? artifactsName(repo);
			const prefix = metaPrefix(repo);
			// Clearing `dirty` here means: every push up to now is covered by the
			// fetch this run is about to do. A push after this sets it again.
			await updateRepo(env.DB, repoId, { last_status: "running", last_run_at: startedAt, artifacts_name: name, meta_prefix: prefix, run_instance: event.instanceId, dirty: 0 });
			const existing = mine ? await env.DB.prepare(`SELECT id FROM runs WHERE repo_id = ? AND started_at = ? AND status = 'running'`).bind(repoId, startedAt).first<{ id: number }>() : null;
			const run =
				existing ??
				(await env.DB.prepare(`INSERT INTO runs (repo_id, trigger, started_at, status) VALUES (?, ?, ?, 'running') RETURNING id`).bind(repoId, trigger, startedAt).first<{ id: number }>());
			return {
				runId: run!.id,
				startedAt,
				fullName: repo.full_name,
				artifactsName: name,
				metaPrefix: prefix,
				defaultBranch: repo.default_branch,
				hasWiki: repo.has_wiki === 1,
				starred: repo.account === STARRED,
				pushedAt: repo.pushed_at,
				bundled: repo.storage === "r2-bundle",
				sizeBytes: repo.size_bytes ?? 0,
				// An older metadata layout gets one full resync instead of an incremental one.
				metaCursor: repo.meta_version < META_VERSION ? null : repo.meta_cursor,
				previousCursor: repo.meta_cursor,
				metaUpgrade: repo.meta_version < META_VERSION && repo.meta_cursor !== null,
				gitCurrent: !force && repo.dirty === 0 && repo.storage !== null && repo.pushed_at === repo.synced_pushed_at,
			};
		});
		if (!plan) return { skipped: true };

		const runner = () => runnerFor(env, repoId);
		const sourceToken = async (): Promise<string | null> => {
			if (plan.starred) return null;
			const repo = await getRepo(env.DB, repoId);
			const account = repo && (await getAccount(env.DB, repo.account));
			const dep = await loadDeployment(env.DB);
			const token = dep && (await tokenFor(dep, account));
			if (!token) throw new NonRetryableError(`no GitHub credentials for ${plan.fullName}`);
			return token;
		};

		const detail: Record<string, unknown> = {};
		try {
			let git: GitResult | null = null;
			if (plan.gitCurrent) {
				detail.git = "unchanged";
			} else {
				// A repo too large for Artifacts has its history in the newest
				// bundle. Starting from it lets the container keep force-pushed
				// and deleted refs, exactly as it does for Artifacts-backed repos.
				const seedBundle = plan.bundled ? await step.do("git: find bundle", async () => latestBundle(env.BUCKET, repoId)) : null;
				git = await this.gitJob(step, runner, sourceToken, {
					label: "git",
					jobId: `${event.instanceId}-git`,
					sourcePath: plan.fullName,
					artifactsName: plan.artifactsName,
					description: `Backup of github.com/${plan.fullName}`,
					defaultBranch: plan.defaultBranch,
					pulls: true,
					optional: false,
					seedBundle,
					api: plan.starred ? null : `https://api.github.com/repos/${plan.fullName}`,
					knownSizeBytes: plan.sizeBytes,
				});
				if (!git) throw new NonRetryableError("git sync returned no result");
				detail.git = git;
				const result = git;

				if (result.bundle) {
					const size = result.bundle.size;
					await step.do("bundle: upload", { timeout: "3 hours", retries: { limit: 2, delay: "1 minute" } }, async () => {
						const key = `bundles/${repoId}/${plan.startedAt.replace(/[-:]/g, "")}.bundle`;
						await putRanged(env.BUCKET, key, size, async (start, end) => {
							const res = await runner().fetch("http://runner/bundle", { headers: { Range: `bytes=${start}-${end}` } });
							if (!res.ok || !res.body) throw new Error(`bundle download failed: ${res.status}`);
							return res.body;
						});
						// Each bundle now carries every kept snapshot from the one
						// before it, so older bundles can go.
						await pruneBundles(env.BUCKET, repoId);
					});
				}

				// The git data is safe at this point; say so before anything else can fail.
				await step.do("git: record", async () => {
					await updateRepo(env.DB, repoId, {
						storage: result.oversize ? "r2-bundle" : "artifacts",
						size_bytes: result.sizeBytes,
						ref_counts: JSON.stringify(result.refs),
						// A full sync saw every object, so its LFS count is the total.
						...(result.lfs.incremental ? {} : { lfs_count: result.lfs.count, lfs_bytes: result.lfs.bytes }),
					});
				});

				if (result.lfs.count > 0) {
					await step.do("lfs: manifest", async () => {
						const res = await runner().fetch("http://runner/lfs.json");
						if (!res.ok) throw new Error(`LFS manifest download failed: ${res.status}`);
						const found = await res.json<LfsObject[]>();
						// An incremental sync reports only new pointers; add them to the known ones.
						const known = result.lfs.incremental ? ((await (await env.BUCKET.get(lfsManifestKey(repoId)))?.json<LfsObject[]>()) ?? []) : [];
						const all = [...new Map([...known, ...found].map((o) => [o.oid, o])).values()];
						await env.BUCKET.put(lfsManifestKey(repoId), JSON.stringify(all));
						await env.BUCKET.put(lfsPendingKey(repoId), JSON.stringify(found));
						await updateRepo(env.DB, repoId, { lfs_count: all.length, lfs_bytes: all.reduce((n, o) => n + o.size, 0) });
					});
				}
			}

			// The wiki is checked on every run: editing it does not count as a
			// push to the repository, so it cannot ride on the git step.
			if (plan.hasWiki) {
				const wiki = await this.gitJob(step, runner, sourceToken, {
					label: "wiki",
					jobId: `${event.instanceId}-wiki`,
					sourcePath: `${plan.fullName}.wiki`,
					artifactsName: `${plan.artifactsName}.wiki`,
					description: `Backup of the github.com/${plan.fullName} wiki`,
					defaultBranch: null,
					pulls: false,
					optional: true,
					seedBundle: null,
					api: null,
					knownSizeBytes: 0,
				});
				if (wiki?.oversize) throw new NonRetryableError(`the wiki is too large for Artifacts and was not backed up: ${wiki.oversize}`);
				if (wiki) detail.wiki = { refs: wiki.refs, sizeBytes: wiki.sizeBytes, newSnapshots: wiki.newSnapshots };
			}

			await step.do("runner: stop", async () => {
				await runner().destroy().catch(() => {});
			});

			if (git && git.lfs.count > 0) {
				let copied = 0;
				let missing = 0;
				for (let offset = 0; offset < git.lfs.count; offset += LFS_BATCH) {
					const res = await step.do(`lfs: copy ${offset}`, { timeout: "2 hours", retries: { limit: 3, delay: "1 minute", backoff: "exponential" } }, async () => {
						const manifest = await env.BUCKET.get(lfsPendingKey(repoId));
						if (!manifest) throw new NonRetryableError("LFS manifest is missing");
						const objects = (await manifest.json<LfsObject[]>()).slice(offset, offset + LFS_BATCH);
						const out = await copyLfsObjects(env.BUCKET, plan.fullName, await sourceToken(), objects);
						return { copied: out.copied, missing: out.missing.length };
					});
					copied += res.copied;
					missing += res.missing;
				}
				detail.lfs = { objects: git.lfs.count, bytes: git.lfs.bytes, copied, missing };
			}

			// Metadata of starred repos is skipped: popular projects have
			// hundreds of thousands of issues that are not yours to lose.
			let metaComplete = true;
			if (!plan.starred) {
				const stored: Record<string, number> = {};
				if (plan.metaUpgrade) {
					await step.do("meta: upgrade layout", async () => regroupFlatComments(env.BUCKET, plan.metaPrefix));
				}
				for (const resource of RESOURCES) {
					let url: string | null = null;
					let waits = 0;
					for (let page = 0; ; ) {
						const res: PageResult = await step.do(
							`meta: ${resource.name} ${page}${waits ? ` (attempt ${waits + 1})` : ""}`,
							{ timeout: "30 minutes", retries: { limit: 4, delay: "30 seconds", backoff: "exponential" } },
							async () => syncMetadataPage(env.BUCKET, await sourceToken(), plan.fullName, plan.metaPrefix, resource, url, plan.metaCursor, { db: env.DB, repoId }),
						);
						if (res.retryAt) {
							// Rate limited: wait for GitHub's reset and ask for the same page again.
							if (++waits > MAX_RATE_LIMIT_WAITS) throw new Error(`GitHub kept rate-limiting ${resource.name}; the next run continues from the same point`);
							await step.sleepUntil(`meta: ${resource.name} ${page} wait ${waits}`, new Date(res.retryAt));
							continue;
						}
						stored[resource.name] = (stored[resource.name] ?? 0) + res.stored;
						url = res.next;
						if (!url) break;
						if (++page >= MAX_META_PAGES) {
							metaComplete = false;
							break;
						}
					}
				}
				detail.metadata = stored;
				if (!metaComplete) detail.metadataIncomplete = `more than ${MAX_META_PAGES} pages of one kind; the rest is fetched on later runs`;
			}

			await step.do("finish", async () => {
				const now = cursorNow();
				await updateRepo(env.DB, repoId, {
					last_status: "ok",
					last_error: null,
					last_success_at: now,
					synced_pushed_at: plan.pushedAt,
					// The cursor only moves when everything up to it was really fetched.
					meta_cursor: plan.starred ? null : metaComplete ? plan.startedAt : plan.previousCursor,
					...(metaComplete ? { meta_version: META_VERSION } : {}),
					run_instance: null,
				});
				await env.DB.prepare(`UPDATE runs SET status = 'ok', finished_at = ?, detail = ? WHERE id = ?`).bind(now, JSON.stringify(detail), plan.runId).run();
				// Keep the run log bounded.
				await env.DB.prepare(`DELETE FROM runs WHERE repo_id = ? AND id NOT IN (SELECT id FROM runs WHERE repo_id = ? ORDER BY id DESC LIMIT 50)`).bind(repoId, repoId).run();
				// A push that arrived while this run was fetching is not in it. Go again.
				const after = await getRepo(env.DB, repoId);
				if (after?.dirty) {
					await env.BACKUP_WORKFLOW.create({ id: `repo-${repoId}-${Date.now()}`, params: { repoId, trigger: "push", force: true } satisfies BackupParams });
				}
			});
			return detail;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (message.includes(BUSY)) {
				// Leave the repo and its container to the sync that owns them.
				await step.do("record skip", async () => {
					await env.DB.prepare(`UPDATE runs SET status = 'skipped', finished_at = ?, detail = ? WHERE id = ?`)
						.bind(cursorNow(), JSON.stringify({ error: BUSY }), plan.runId)
						.run();
				});
				return { skipped: true };
			}
			await step.do("record failure", async () => {
				const now = cursorNow();
				await updateRepo(env.DB, repoId, { last_status: "error", last_error: message.slice(0, 2000), run_instance: null });
				await env.DB.prepare(`UPDATE runs SET status = 'error', finished_at = ?, detail = ? WHERE id = ?`)
					.bind(now, JSON.stringify({ ...detail, error: message.slice(0, 2000) }), plan.runId)
					.run();
				await runner().destroy().catch(() => {});
			});
			throw err;
		}
	}

	/** Runs one mirror job in the container and waits for it to finish. */
	private async gitJob(
		step: WorkflowStep,
		runner: () => DurableObjectStub<GitRunner>,
		sourceToken: () => Promise<string | null>,
		job: GitJob,
	): Promise<GitResult | null> {
		const env = this.env;
		const sourceUrl = `https://github.com/${job.sourcePath}.git`;

		const started = await step.do(`${job.label}: start`, { timeout: "2 hours", retries: { limit: 3, delay: "20 seconds", backoff: "exponential" } }, async () => {
			const token = await sourceToken();
			const authHeader = token ? gitBasicAuth(token) : undefined;
			if (job.optional) {
				const probe = await fetch(`${sourceUrl}/info/refs?service=git-upload-pack`, {
					headers: { "User-Agent": "git/2.47.0", ...(authHeader ? { Authorization: authHeader } : {}) },
				});
				if (!probe.ok) return false;
			}

			let repo: ArtifactsRepo;
			try {
				repo = await env.ARTIFACTS.get(job.artifactsName);
			} catch {
				await env.ARTIFACTS.create(job.artifactsName, {
					description: job.description,
					...(job.defaultBranch ? { setDefaultBranch: job.defaultBranch } : {}),
				});
				repo = await env.ARTIFACTS.get(job.artifactsName);
			}
			let remote: string;
			let targetToken: string;
			try {
				remote = (await repo.info()).remote;
				targetToken = (await repo.createToken("write", ARTIFACTS_TOKEN_TTL)).plaintext;
			} finally {
				repo[Symbol.dispose]();
			}

			if (job.seedBundle) {
				const bundle = await env.BUCKET.get(job.seedBundle);
				if (!bundle) throw new Error(`bundle ${job.seedBundle} is missing`);
				const seeded = await runner().fetch("http://runner/seed", { method: "POST", headers: { "x-job-id": job.jobId }, body: bundle.body });
				if (seeded.status === 409) throw new NonRetryableError(BUSY);
				if (!seeded.ok) throw new Error(`runner refused the bundle: ${seeded.status} ${await seeded.text()}`);
			}

			const res = await runner().fetch("http://runner/sync", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					id: job.jobId,
					source: { url: sourceUrl, authHeader, pulls: job.pulls, ...(job.api ? { api: job.api } : {}) },
					knownSizeBytes: job.knownSizeBytes,
					target: { url: remote, authHeader: `Bearer ${targetToken}` },
					limits: { maxBlobBytes: MAX_BLOB_BYTES, maxRepoBytes: MAX_REPO_BYTES },
					seeded: !!job.seedBundle,
				}),
			});
			if (res.status === 409) throw new NonRetryableError(BUSY);
			if (res.status !== 202) throw new Error(`runner refused the job: ${res.status} ${await res.text()}`);
			return true;
		});
		if (!started) return null;

		for (let i = 0; i < MAX_POLLS; i++) {
			await step.sleep(`${job.label}: wait ${i}`, `${pollSeconds(i)} seconds`);
			const status = await step.do(`${job.label}: poll ${i}`, { retries: { limit: 5, delay: "10 seconds" } }, async () => {
				const res = await runner().fetch("http://runner/status");
				if (!res.ok) throw new Error(`runner status failed: ${res.status}`);
				return res.json<RunnerStatus>();
			});
			if (status.state === "running" && status.id === job.jobId) continue;
			if (status.state === "done" && status.id === job.jobId && status.result) return status.result;
			if (status.state === "error" && status.id === job.jobId) {
				if (job.optional && status.error?.code === "SOURCE_NOT_FOUND") return null;
				throw new NonRetryableError(`${job.label}: ${status.error?.message ?? "sync failed"}`);
			}
			// The container restarted and forgot the job.
			throw new Error(`${job.label}: runner lost the job (state ${status.state})`);
		}
		throw new NonRetryableError(`${job.label}: timed out`);
	}
}
