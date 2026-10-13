// The three git-over-HTTP exchanges an incremental sync needs, spoken
// directly so that only new objects ever travel:
//
//   advertisedRefs  what the backup holds now
//   fetchPack       ask the source for what the backup lacks, as one pack
//   pushCommands    hand that pack to the backup together with ref updates
//
// Stock `git fetch` cannot do the middle step without a local copy of the
// history, which is exactly the download this avoids.

import { createWriteStream, openAsBlob } from "node:fs";
import { createHash } from "node:crypto";
import { once } from "node:events";

export const ZERO = "0".repeat(40);
const AGENT = "git/2.47.0";

/** A valid pack holding no objects, for pushes that only move refs. */
export const EMPTY_PACK = (() => {
	const header = Buffer.from([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 0]);
	return Buffer.concat([header, createHash("sha1").update(header).digest()]);
})();

export class RelayError extends Error {}

const pkt = (text) => {
	const body = Buffer.from(text);
	return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, "0")), body]);
};
const FLUSH = Buffer.from("0000");
const DELIM = Buffer.from("0001");

/** Yields each pkt-line payload from a byte stream; flush and delimiter packets come out as null. */
async function* pktLines(stream) {
	let buffer = Buffer.alloc(0);
	for await (const chunk of stream) {
		buffer = buffer.length ? Buffer.concat([buffer, chunk]) : Buffer.from(chunk);
		for (;;) {
			if (buffer.length < 4) break;
			const length = parseInt(buffer.toString("latin1", 0, 4), 16);
			if (Number.isNaN(length)) throw new RelayError(`malformed response: ${buffer.toString("latin1", 0, 80)}`);
			if (length < 4) {
				buffer = buffer.subarray(4);
				yield null;
				continue;
			}
			if (buffer.length < length) break;
			yield buffer.subarray(4, length);
			buffer = buffer.subarray(length);
		}
	}
	if (buffer.length) throw new RelayError("response ended in the middle of a packet");
}

const headers = (authHeader, extra) => ({ "User-Agent": AGENT, ...(authHeader ? { Authorization: authHeader } : {}), ...extra });

async function failure(res, what) {
	const text = (await res.text().catch(() => "")).slice(0, 300);
	return new RelayError(`${what} failed: HTTP ${res.status} ${text}`);
}

/**
 * The refs a remote will accept pushes against, with its capabilities.
 * @returns {Promise<{ refs: Map<string, string>, capabilities: Set<string> }>}
 */
export async function advertisedRefs(url, authHeader) {
	const res = await fetch(`${url}/info/refs?service=git-receive-pack`, { headers: headers(authHeader) });
	if (!res.ok) throw await failure(res, "listing the backup's refs");
	const refs = new Map();
	const capabilities = new Set();
	for await (const line of pktLines(res.body)) {
		if (!line) continue;
		const [entry, caps] = line.toString("utf8").replace(/\n$/, "").split("\0");
		if (entry.startsWith("#")) continue;
		for (const cap of caps?.split(" ") ?? []) capabilities.add(cap);
		const space = entry.indexOf(" ");
		const [sha, ref] = [entry.slice(0, space), entry.slice(space + 1)];
		if (sha.length === 40 && ref.startsWith("refs/")) refs.set(ref, sha);
	}
	return { refs, capabilities };
}

/**
 * Asks the source for every object reachable from `wants` that is not
 * reachable from `haves`, and writes the resulting pack to `outPath`.
 * @returns {Promise<number>} bytes written
 */
export async function fetchPack(url, authHeader, wants, haves, outPath) {
	const body = Buffer.concat([
		pkt("command=fetch\n"),
		pkt(`agent=${AGENT}\n`),
		pkt("object-format=sha1\n"),
		DELIM,
		pkt("no-progress\n"),
		...wants.map((sha) => pkt(`want ${sha}\n`)),
		...haves.map((sha) => pkt(`have ${sha}\n`)),
		pkt("done\n"),
		FLUSH,
	]);
	const res = await fetch(`${url}/git-upload-pack`, {
		method: "POST",
		headers: headers(authHeader, { "Content-Type": "application/x-git-upload-pack-request", Accept: "application/x-git-upload-pack-result", "Git-Protocol": "version=2" }),
		body,
	});
	if (!res.ok) throw await failure(res, "fetching new objects from the source");

	const out = createWriteStream(outPath);
	let bytes = 0;
	let inPack = false;
	try {
		for await (const line of pktLines(res.body)) {
			if (!line) continue;
			if (!inPack) {
				const text = line.toString("utf8");
				if (text === "packfile\n") inPack = true;
				else if (text.startsWith("ERR ")) throw new RelayError(`the source refused the fetch: ${text.slice(4).trim()}`);
				continue;
			}
			// Side-band: 1 is pack data, 2 is progress, 3 is a fatal error.
			const band = line[0];
			if (band === 1) {
				bytes += line.length - 1;
				if (!out.write(line.subarray(1))) await once(out, "drain");
			} else if (band === 3) {
				throw new RelayError(`the source reported an error: ${line.subarray(1).toString("utf8").trim()}`);
			}
		}
	} finally {
		out.end();
		await once(out, "close");
	}
	if (!inPack) throw new RelayError("the source sent no pack");
	return bytes;
}

/**
 * Applies ref updates on the backup, sending `packPath` (or an empty pack)
 * along with them. Each command names the value it expects the ref to have,
 * so a ref that moved in the meantime is refused rather than overwritten.
 * @param commands {{ ref: string, old: string, new: string }[]}
 * @returns {Promise<Map<string, string | null>>} per ref: null if applied, else the reason it was refused
 */
export async function pushCommands(url, authHeader, commands, packPath) {
	if (commands.length === 0) return new Map();
	const lines = commands.map((c, i) => pkt(`${c.old} ${c.new} ${c.ref}${i === 0 ? `\0report-status agent=${AGENT}` : ""}\n`));
	// A push that only deletes refs carries no pack at all.
	const onlyDeletes = commands.every((c) => c.new === ZERO);
	const pack = onlyDeletes ? [] : [packPath ? await openAsBlob(packPath) : EMPTY_PACK];
	const res = await fetch(`${url}/git-receive-pack`, {
		method: "POST",
		headers: headers(authHeader, { "Content-Type": "application/x-git-receive-pack-request", Accept: "application/x-git-receive-pack-result" }),
		body: new Blob([...lines, FLUSH, ...pack]),
	});
	if (!res.ok) throw await failure(res, "pushing to the backup");

	const results = new Map();
	let unpack = null;
	for await (const line of pktLines(res.body)) {
		if (!line) continue;
		const text = line.toString("utf8").replace(/\n$/, "");
		if (text.startsWith("unpack ")) unpack = text.slice(7);
		else if (text.startsWith("ok ")) results.set(text.slice(3), null);
		else if (text.startsWith("ng ")) {
			const rest = text.slice(3);
			const space = rest.indexOf(" ");
			results.set(space < 0 ? rest : rest.slice(0, space), space < 0 ? "refused" : rest.slice(space + 1));
		}
	}
	if (unpack !== "ok") throw new RelayError(`the backup rejected the pack: ${unpack ?? "no status returned"}`);
	for (const c of commands) if (!results.has(c.ref)) results.set(c.ref, "no status returned");
	return results;
}
