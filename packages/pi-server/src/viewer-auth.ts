import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

interface AuthState {
	failures: number;
	generation: number;
}

function readStateSync(directory: string): AuthState {
	const path = join(directory, "auth.json");
	return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as AuthState) : { failures: 0, generation: 0 };
}

async function readState(directory: string): Promise<AuthState> {
	try {
		return JSON.parse(await readFile(join(directory, "auth.json"), "utf8")) as AuthState;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { failures: 0, generation: 0 };
		throw error;
	}
}

async function writeState(directory: string, state: AuthState): Promise<void> {
	await mkdir(directory, { recursive: true });
	const path = join(directory, "auth.json");
	await writeFile(`${path}.tmp`, JSON.stringify(state), { mode: 0o600 });
	await rename(`${path}.tmp`, path);
}

export async function unlockViewer(sessionStoreDir: string): Promise<void> {
	const directory = join(sessionStoreDir, ".viewer");
	const state = await readState(directory);
	await writeState(directory, { failures: 0, generation: state.generation + 1 });
}

export class ViewerAuth {
	private readonly directory: string;
	private readonly token: string | undefined;
	private state: AuthState;
	private pendingStateOperation: Promise<void> = Promise.resolve();
	private readonly cookies = new Map<string, number>();
	private readonly responses = new Map<ServerResponse, string | undefined>();
	private cookieTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(sessionStoreDir: string, token: string | undefined) {
		this.directory = join(sessionStoreDir, ".viewer");
		this.token = token;
		this.state = readStateSync(this.directory);
	}

	get configured(): boolean {
		return Boolean(this.token);
	}

	close(): void {
		clearTimeout(this.cookieTimer);
		this.cookieTimer = undefined;
		this.cookies.clear();
	}

	private scheduleCookieExpiry(): void {
		clearTimeout(this.cookieTimer);
		this.cookieTimer = undefined;
		const now = Date.now();
		let next = Infinity;
		for (const [cookie, expiry] of this.cookies) {
			if (expiry <= now) this.cookies.delete(cookie);
			else next = Math.min(next, expiry);
		}
		if (next === Infinity) return;
		this.cookieTimer = setTimeout(() => this.scheduleCookieExpiry(), next - now);
		this.cookieTimer.unref();
	}

	get remainingAttempts(): number {
		return Math.max(0, 10 - this.state.failures);
	}

	isLocked(): Promise<boolean> {
		return this.withState(() => this.refreshState());
	}

	private withState<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.pendingStateOperation.then(operation);
		this.pendingStateOperation = result.then(
			() => {},
			() => {},
		);
		return result;
	}

	private async refreshState(): Promise<boolean> {
		const current = await readState(this.directory);
		if (current.generation !== this.state.generation || current.failures >= 10) {
			this.cookies.clear();
			this.scheduleCookieExpiry();
			for (const response of this.responses.keys()) response.end();
			this.responses.clear();
		}
		this.state = current;
		return current.failures >= 10;
	}

	authenticate(req: IncomingMessage, login = false): Promise<200 | 401 | 423> {
		return this.withState(async () => {
			if (await this.refreshState()) return 423;
			if (!this.token) return login ? 401 : 200;
			const header = req.headers.authorization;
			if (!header && !login) return 401;
			const received = Buffer.from(header?.startsWith("Bearer ") ? header.slice(7) : login ? "" : (header ?? ""));
			const expected = Buffer.from(this.token);
			if (received.length === expected.length && timingSafeEqual(received, expected)) {
				if (login && this.state.failures) {
					this.state.failures = 0;
					await writeState(this.directory, this.state);
				}
				return 200;
			}
			this.state.failures++;
			await writeState(this.directory, this.state);
			if (this.state.failures < 10) return 401;
			this.cookies.clear();
			this.scheduleCookieExpiry();
			for (const response of this.responses.keys()) response.end();
			this.responses.clear();
			return 423;
		});
	}

	createCookie(req: IncomingMessage): string {
		const cookie = randomBytes(32).toString("base64url");
		this.cookies.set(cookie, Date.now() + 12 * 60 * 60 * 1000);
		this.scheduleCookieExpiry();
		return `pi_viewer=${cookie}; Path=/viewer; HttpOnly; SameSite=Strict; Max-Age=43200${this.secure(req) ? "; Secure" : ""}`;
	}

	clearCookie(req: IncomingMessage): string {
		const cookie = this.cookie(req);
		if (cookie) {
			this.cookies.delete(cookie);
			this.scheduleCookieExpiry();
			for (const [response, boundCookie] of this.responses) if (boundCookie === cookie) response.end();
		}
		return `pi_viewer=; Path=/viewer; HttpOnly; SameSite=Strict; Max-Age=0${this.secure(req) ? "; Secure" : ""}`;
	}

	hasCookie(req: IncomingMessage): boolean {
		const cookie = this.cookie(req);
		const expires = cookie ? this.cookies.get(cookie) : undefined;
		if (!cookie || expires === undefined) return false;
		if (expires <= Date.now()) {
			this.cookies.delete(cookie);
			this.scheduleCookieExpiry();
			return false;
		}
		return true;
	}

	track(response: ServerResponse, req?: IncomingMessage): void {
		this.responses.set(response, req ? this.cookie(req) : undefined);
		response.once("close", () => this.responses.delete(response));
	}

	private cookie(req: IncomingMessage): string | undefined {
		return req.headers.cookie
			?.split(";")
			.map((part) => part.trim())
			.find((part) => part.startsWith("pi_viewer="))
			?.slice(10);
	}

	private secure(req: IncomingMessage): boolean {
		return "encrypted" in req.socket || req.headers.origin?.startsWith("https://") === true;
	}
}
