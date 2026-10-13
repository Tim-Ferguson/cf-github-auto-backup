import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { ensureSchema, getAccount, getRepo, isBackedUp, type Repo, STARRED, updateRepo } from "./db.ts";
import { gitBasicAuth, installationToken, loadApp } from "./github.ts";
import { RESOURCES, syncMetadataPage } from "./metadata.ts";
import { type GitRunner, runnerFor } from "./runner.ts";
import { copyLfsObjects, type LfsObject, lfsManifestKey, pruneBundles, putRanged, putStream } from "./storage.ts";

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
const RUNNING_GRACE_MS = 60 * 60 * 1000;
const BUSY = "another sync of this repository is still running";
const ARTIFACTS_TOKEN_TTL = 6 * 60 * 60;

interface GitResult {
	refs: { heads: number; tags: number; pulls: number; snapshots: number };
	updated: number;
	deleted: number;
	deleteFailures: number;
	newSnapshots: string[];
	sizeBytes: number;
	oversize: string | null;
	bundle: { size: number } | null;
	lfs: { count: number; bytes: number };
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
}

/** Artifacts names allow letters, digits, dots, underscores and hyphens. */
export function artifactsName(repo: Pick<Repo, "id" | "full_name">): string {
	const name = repo.full_name.replace("/", "--").replace(/[^A-Za-z0-9._-]/g, "-");
	return name.length <= 56 ? name : `${name.slice(0, 44)}-${repo.id}`;
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
			// Two syncs of one repo would fight over the same container.
			if (repo.last_status === "running" && repo.last_run_at && Date.now() - Date.parse(repo.last_run_at) < RUNNING_GRACE_MS) return null;
			const startedAt = cursorNow();
			const name = repo.artifacts_name ?? artifactsName(repo);
			await updateRepo(env.DB, repoId, { last_status: "running", last_run_at: startedAt, artifacts_name: name });
			const run = await env.DB.prepare(`INSERT INTO runs (repo_id, trigger, started_at, status) VALUES (?, ?, ?, 'running') RETURNING id`)
				.bind(repoId, trigger, startedAt)
				.first<{ id: number }>();
			return {
				runId: run!.id,
				startedAt,
				fullName: repo.full_name,
				artifactsName: name,
				defaultBranch: repo.default_branch,
				hasWiki: repo.has_wiki === 1,
				starred: repo.account === STARRED,
				pushedAt: repo.pushed_at,
				metaCursor: repo.meta_cursor,
				gitCurrent: !force && repo.storage !== null && repo.pushed_at === repo.synced_pushed_at,
			};
		});
		if (!plan) return { skipped: true };

		const runner = () => runnerFor(env, repoId);
		const sourceToken = async (): Promise<string | null> => {
			if (plan.starred) return null;
			const repo = await getRepo(env.DB, repoId);
			const account = repo && (await getAccount(env.DB, repo.account));
			const app = await loadApp(env.DB);
			if (!app || !account?.installation_id) throw new NonRetryableError(`no GitHub installation for ${plan.fullName}`);
			return installationToken(app, account.installation_id);
		};

		const detail: Record<string, unknown> = {};
		try {
			if (plan.gitCurrent) {
				detail.git = "unchanged";
			} else {
				const git = await this.gitJob(step, runner, sourceToken, {
					label: "git",
					jobId: `${event.instanceId}-git`,
					sourcePath: plan.fullName,
					artifactsName: plan.artifactsName,
					description: `Backup of github.com/${plan.fullName}`,
					defaultBranch: plan.defaultBranch,
					pulls: true,
					optional: false,
				});
				if (!git) throw new NonRetryableError("git sync returned no result");
				detail.git = git;

				if (git.bundle) {
					const size = git.bundle.size;
					await step.do("bundle: upload", { timeout: "3 hours", retries: { limit: 2, delay: "1 minute" } }, async () => {
						const key = `bundles/${repoId}/${plan.startedAt.replace(/[-:]/g, "")}.bundle`;
						await putRanged(env.BUCKET, key, size, async (start, end) => {
							const res = await runner().fetch("http://runner/bundle", { headers: { Range: `bytes=${start}-${end}` } });
							if (!res.ok || !res.body) throw new Error(`bundle download failed: ${res.status}`);
							return res.body;
						});
						await pruneBundles(env.BUCKET, repoId);
					});
				}

				if (git.lfs.count > 0) {
					await step.do("lfs: manifest", async () => {
						const res = await runner().fetch("http://runner/lfs.json");
						if (!res.ok || !res.body) throw new Error(`LFS manifest download failed: ${res.status}`);
						await putStream(env.BUCKET, lfsManifestKey(repoId), res.body, Number(res.headers.get("content-length")));
					});
				}

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
					});
					if (wiki) detail.wiki = { refs: wiki.refs, sizeBytes: wiki.sizeBytes, newSnapshots: wiki.newSnapshots };
				}

				await step.do("runner: stop", async () => {
					await runner().destroy().catch(() => {});
				});

				let copied = 0;
				let missing = 0;
				for (let offset = 0; offset < git.lfs.count; offset += LFS_BATCH) {
					const res = await step.do(`lfs: copy ${offset}`, { timeout: "2 hours", retries: { limit: 3, delay: "1 minute", backoff: "exponential" } }, async () => {
						const manifest = await env.BUCKET.get(lfsManifestKey(repoId));
						if (!manifest) throw new NonRetryableError("LFS manifest is missing");
						const objects = (await manifest.json<LfsObject[]>()).slice(offset, offset + LFS_BATCH);
						const out = await copyLfsObjects(env.BUCKET, plan.fullName, await sourceToken(), objects);
						return { copied: out.copied, missing: out.missing.length };
					});
					copied += res.copied;
					missing += res.missing;
				}
				if (git.lfs.count > 0) detail.lfs = { objects: git.lfs.count, bytes: git.lfs.bytes, copied, missing };

				await step.do("git: record", async () => {
					await updateRepo(env.DB, repoId, {
						storage: git.oversize ? "r2-bundle" : "artifacts",
						size_bytes: git.sizeBytes,
						ref_counts: JSON.stringify(git.refs),
						lfs_count: git.lfs.count,
						lfs_bytes: git.lfs.bytes,
					});
				});
			}

			// Metadata of starred repos is skipped: popular projects have
			// hundreds of thousands of issues that are not yours to lose.
			if (!plan.starred) {
				const stored: Record<string, number> = {};
				for (const resource of RESOURCES) {
					let url: string | null = null;
					for (let page = 0; page < 2000; page++) {
						const res: { next: string | null; stored: number } = await step.do(
							`meta: ${resource.name} ${page}`,
							{ timeout: "30 minutes", retries: { limit: 4, delay: "30 seconds", backoff: "exponential" } },
							async () => syncMetadataPage(env.BUCKET, await sourceToken(), plan.fullName, resource, url, plan.metaCursor),
						);
						stored[resource.name] = (stored[resource.name] ?? 0) + res.stored;
						url = res.next;
						if (!url) break;
					}
				}
				detail.metadata = stored;
			}

			await step.do("finish", async () => {
				const now = cursorNow();
				await updateRepo(env.DB, repoId, {
					last_status: "ok",
					last_error: null,
					last_success_at: now,
					synced_pushed_at: plan.pushedAt,
					meta_cursor: plan.starred ? null : plan.startedAt,
				});
				await env.DB.prepare(`UPDATE runs SET status = 'ok', finished_at = ?, detail = ? WHERE id = ?`).bind(now, JSON.stringify(detail), plan.runId).run();
				// Keep the run log bounded.
				await env.DB.prepare(`DELETE FROM runs WHERE repo_id = ? AND id NOT IN (SELECT id FROM runs WHERE repo_id = ? ORDER BY id DESC LIMIT 50)`).bind(repoId, repoId).run();
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
				await updateRepo(env.DB, repoId, { last_status: "error", last_error: message.slice(0, 2000) });
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

		const started = await step.do(`${job.label}: start`, { timeout: "10 minutes", retries: { limit: 3, delay: "20 seconds", backoff: "exponential" } }, async () => {
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

			const res = await runner().fetch("http://runner/sync", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					id: job.jobId,
					source: { url: sourceUrl, authHeader, pulls: job.pulls },
					target: { url: remote, authHeader: `Bearer ${targetToken}` },
					limits: { maxBlobBytes: MAX_BLOB_BYTES, maxRepoBytes: MAX_REPO_BYTES },
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
