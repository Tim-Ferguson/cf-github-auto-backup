import { bindings, defineConfig, defineContainer, exports, triggers } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

declare const process: {
	env: Record<string, string | undefined>;
	getBuiltinModule(id: "node:fs"): { existsSync(path: string): boolean; readFileSync(path: string, encoding: "utf8"): string };
};

// Storage keeps these names whatever the Worker is called, so a deployment
// can change its name (and with it its workers.dev address) and keep its data.
const STORAGE = "gh-backup";

/**
 * The Worker's name decides its address: https://<name>.<account>.workers.dev.
 * `npm run cli -- move` picks a new one and records it in .gh-backup.json.
 */
function workerName(): string {
	let name = process.env.GH_BACKUP_NAME;
	if (!name) {
		try {
			const fs = process.getBuiltinModule("node:fs");
			if (fs.existsSync(".gh-backup.json")) name = JSON.parse(fs.readFileSync(".gh-backup.json", "utf8")).name;
		} catch {
			// No readable state file: fall through to the default.
		}
	}
	return name && /^[a-z0-9][a-z0-9-]{0,53}$/.test(name) ? name : STORAGE;
}

const WORKER_NAME = workerName();

// Runs real `git` for each sync. Bump instanceType if you back up repos
// larger than a few GB (standard-1 has an 8 GB disk).
const gitRunner = defineContainer({
	name: `${WORKER_NAME}-git-runner`,
	image: { dockerfile: "./container/Dockerfile", buildContext: "./container" },
	instanceType: "standard-1",
	maxInstances: 4,
});

// Lets you work on the dashboard with `GH_BACKUP_NO_CONTAINER=1 cf dev` on a
// machine without Docker. Syncs cannot run in that mode.
const withContainer = process.env.GH_BACKUP_NO_CONTAINER !== "1";

export default defineConfig({
	containers: withContainer ? [gitRunner] : [],
	worker: {
		name: WORKER_NAME,
		compatibilityDate: "2026-10-06",
		compatibilityFlags: ["nodejs_compat"],
		entrypoint,
		observability: { enabled: true },
		triggers: [
			// Discover repos and queue anything that changed. Pushes also
			// trigger a sync through the GitHub webhook.
			triggers.scheduled({ schedule: "17 */6 * * *" }),
		],
		exports: {
			GitRunner: exports.durableObject({ storage: "sqlite", ...(withContainer ? { container: gitRunner } : {}) }),
			BackupWorkflow: exports.workflow({
				name: `${WORKER_NAME}-backup`,
				concurrency: { limit: 4 },
			}),
		},
		env: {
			// Chosen at deploy time. Until it is set, the deployment stays locked.
			ADMIN_PASSWORD: bindings.secret(),
			DB: bindings.d1({ name: `${STORAGE}-db` }),
			BUCKET: bindings.r2({ name: `${STORAGE}-data` }),
			ARTIFACTS: bindings.artifacts({ namespace: STORAGE }),
			GIT_RUNNER: bindings.durableObject({ worker: WORKER_NAME, exportName: "GitRunner" }),
			BACKUP_WORKFLOW: bindings.workflow({
				name: `${WORKER_NAME}-backup`,
				worker: WORKER_NAME,
				exportName: "BackupWorkflow",
			}),
		},
	},
});
