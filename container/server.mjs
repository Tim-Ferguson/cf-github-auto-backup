// HTTP front for syncRepo. Only the GitRunner Durable Object can reach this
// server, so there is no auth here. One job at a time per container.

import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createServer } from "node:http";
import { syncRepo } from "./sync.mjs";

const WORKDIR = process.env.WORKDIR ?? "/work";
// Outside WORKDIR, which every sync wipes before it starts.
const SEED = `${WORKDIR}.seed.bundle`;

/** @type {{ id: string, state: "running" | "done" | "error", phase: string, result?: any, error?: { code: string, message: string } } | null} */
let job = null;

async function readJson(req) {
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(res, status, body) {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}

function sendFile(req, res, file, type) {
	if (!file) return json(res, 404, { error: "not available" });
	const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? "");
	const start = range ? Number(range[1]) : 0;
	const end = range ? Math.min(Number(range[2]), file.size - 1) : file.size - 1;
	res.writeHead(range ? 206 : 200, { "content-type": type, "content-length": String(end - start + 1) });
	if (end < start) return res.end();
	createReadStream(file.path, { start, end }).pipe(res);
}

const server = createServer(async (req, res) => {
	try {
		const { pathname } = new URL(req.url, "http://container");
		if (req.method === "POST" && pathname === "/seed") {
			// The existing backup of a repo too large for Artifacts, as a bundle.
			if (job?.state === "running" && job.id !== req.headers["x-job-id"]) return json(res, 409, { error: "busy" });
			if (job?.state === "running") return json(res, 200, { ok: true });
			await pipeline(req, createWriteStream(SEED));
			return json(res, 200, { ok: true });
		}
		if (req.method === "POST" && pathname === "/sync") {
			const body = await readJson(req);
			// A retried start for a job this container already has, running or
			// finished, must not run it again: a second pass would find nothing
			// new and replace the first one's results.
			if (job?.id === body.id) return json(res, 202, { id: job.id });
			if (job?.state === "running") return json(res, 409, { error: "busy" });
			const current = (job = { id: body.id, state: "running", phase: "starting" });
			if (body.seeded && !existsSync(SEED)) return json(res, 409, { error: "the seed bundle did not arrive" });
			const seedBundle = body.seeded ? SEED : undefined;
			syncRepo(body, { workdir: WORKDIR, onPhase: (phase) => (current.phase = phase), seedBundle })
				.then(
					(result) => Object.assign(current, { state: "done", result }),
					(err) => Object.assign(current, { state: "error", error: { code: err.code ?? "INTERNAL", message: String(err.message ?? err) } }),
				)
				.finally(() => rm(SEED, { force: true }));
			return json(res, 202, { id: body.id });
		}
		if (req.method === "GET" && pathname === "/status") {
			if (!job) return json(res, 200, { state: "idle" });
			const { id, state, phase, result, error } = job;
			return json(res, 200, { id, state, phase, error, result: result && { ...result, bundle: result.bundle && { size: result.bundle.size }, lfs: { count: result.lfs.count, bytes: result.lfs.bytes, size: result.lfs.size, incremental: !!result.lfs.incremental } } });
		}
		if (req.method === "GET" && pathname === "/lfs.json") {
			return sendFile(req, res, job?.result?.lfs, "application/json");
		}
		if (req.method === "GET" && pathname === "/bundle") {
			return sendFile(req, res, job?.result?.bundle, "application/octet-stream");
		}
		if (pathname === "/healthz") return json(res, 200, { ok: true });
		json(res, 404, { error: "not found" });
	} catch (err) {
		json(res, 500, { error: String(err?.message ?? err) });
	}
});

server.listen(Number(process.env.PORT ?? 8080), "0.0.0.0");
