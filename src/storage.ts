// R2 layout:
//   lfs/<aa>/<oid>                      LFS objects, content-addressed and shared across repos
//   lfs-manifests/<repo id>.json        every LFS object a repo's history references
//   bundles/<repo id>/<timestamp>.bundle  full git bundles for repos too large for Artifacts
//   meta/<owner>/<repo>/...             issues, pull requests, releases and friends as JSON

import { gitBasicAuth } from "./github.ts";

const SINGLE_PUT_MAX = 4 * 1024 ** 3;
const PART_SIZE = 256 * 1024 ** 2;
const BUNDLES_KEPT = 3;

export const lfsKey = (oid: string) => `lfs/${oid.slice(0, 2)}/${oid}`;
export const lfsManifestKey = (repoId: number) => `lfs-manifests/${repoId}.json`;
export const metaPrefix = (fullName: string) => `meta/${fullName}/`;

/** R2 needs a known length up front, which a plain fetch body does not promise. */
function fixedLength(body: ReadableStream, size: number): ReadableStream {
	const { readable, writable } = new FixedLengthStream(size);
	body.pipeTo(writable).catch(() => {});
	return readable;
}

export async function putStream(bucket: R2Bucket, key: string, body: ReadableStream, size: number, options?: R2PutOptions): Promise<void> {
	await bucket.put(key, fixedLength(body, size), options);
}

/** Copies a large file into R2, in parts when it exceeds a single upload. */
export async function putRanged(
	bucket: R2Bucket,
	key: string,
	size: number,
	fetchRange: (start: number, end: number) => Promise<ReadableStream>,
): Promise<void> {
	if (size <= SINGLE_PUT_MAX) {
		await putStream(bucket, key, await fetchRange(0, size - 1), size);
		return;
	}
	const upload = await bucket.createMultipartUpload(key);
	try {
		const parts: R2UploadedPart[] = [];
		for (let start = 0, n = 1; start < size; start += PART_SIZE, n++) {
			const end = Math.min(start + PART_SIZE, size) - 1;
			parts.push(await upload.uploadPart(n, fixedLength(await fetchRange(start, end), end - start + 1)));
		}
		await upload.complete(parts);
	} catch (err) {
		await upload.abort().catch(() => {});
		throw err;
	}
}

/** Drops all but the newest few bundles for a repo. */
export async function pruneBundles(bucket: R2Bucket, repoId: number): Promise<void> {
	const { objects } = await bucket.list({ prefix: `bundles/${repoId}/` });
	const stale = objects.sort((a, b) => b.key.localeCompare(a.key)).slice(BUNDLES_KEPT);
	if (stale.length) await bucket.delete(stale.map((o) => o.key));
}

export interface LfsObject {
	oid: string;
	size: number;
}

interface LfsBatchResponse {
	objects: {
		oid: string;
		size: number;
		actions?: { download?: { href: string; header?: Record<string, string> } };
		error?: { code: number; message: string };
	}[];
}

/**
 * Copies LFS objects that R2 does not hold yet straight from GitHub.
 * Returns how many were copied and which ones GitHub could not serve.
 */
export async function copyLfsObjects(
	bucket: R2Bucket,
	fullName: string,
	token: string | null,
	objects: LfsObject[],
): Promise<{ copied: number; missing: string[] }> {
	const wanted: LfsObject[] = [];
	for (const obj of objects) {
		if (!(await bucket.head(lfsKey(obj.oid)))) wanted.push(obj);
	}
	if (wanted.length === 0) return { copied: 0, missing: [] };

	const headers: Record<string, string> = {
		Accept: "application/vnd.git-lfs+json",
		"Content-Type": "application/vnd.git-lfs+json",
		"User-Agent": "gh-backup",
	};
	if (token) headers.Authorization = gitBasicAuth(token);
	const res = await fetch(`https://github.com/${fullName}.git/info/lfs/objects/batch`, {
		method: "POST",
		headers,
		body: JSON.stringify({ operation: "download", transfers: ["basic"], objects: wanted }),
	});
	if (!res.ok) throw new Error(`LFS batch for ${fullName} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
	const batch = await res.json<LfsBatchResponse>();

	let copied = 0;
	const missing: string[] = [];
	for (const obj of batch.objects) {
		const download = obj.actions?.download;
		if (!download) {
			missing.push(obj.oid);
			continue;
		}
		const file = await fetch(download.href, { headers: download.header });
		if (!file.ok || !file.body) throw new Error(`LFS download of ${obj.oid} failed: ${file.status}`);
		await putStream(bucket, lfsKey(obj.oid), file.body, obj.size);
		copied++;
	}
	return { copied, missing };
}
