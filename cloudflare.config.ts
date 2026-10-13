import { bindings, defineConfig, defineContainer, exports, triggers } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

const WORKER_NAME = "gh-backup";

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
declare const process: { env: Record<string, string | undefined> };
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
			DB: bindings.d1({ name: `${WORKER_NAME}-db` }),
			BUCKET: bindings.r2({ name: `${WORKER_NAME}-data` }),
			ARTIFACTS: bindings.artifacts({ namespace: WORKER_NAME }),
			GIT_RUNNER: bindings.durableObject({ worker: WORKER_NAME, exportName: "GitRunner" }),
			BACKUP_WORKFLOW: bindings.workflow({
				name: `${WORKER_NAME}-backup`,
				worker: WORKER_NAME,
				exportName: "BackupWorkflow",
			}),
		},
	},
});
