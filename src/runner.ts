import { Container, getContainer } from "@cloudflare/containers";

/** One container instance per repo sync; it runs container/server.mjs. */
export class GitRunner extends Container<Env> {
	defaultPort = 8080;
	sleepAfter = "20m";
	enableInternet = true;
}

export function runnerFor(env: Env, repoId: number): DurableObjectStub<GitRunner> {
	// The generated Env types the binding by Worker name, not by class.
	return getContainer(env.GIT_RUNNER as unknown as DurableObjectNamespace<GitRunner>, `repo-${repoId}`);
}
