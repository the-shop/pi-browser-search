/**
 * Minimal Chrome DevTools Protocol client.
 *
 * Deliberately dependency-free: Node 22+ ships `WebSocket` and `fetch`, so the
 * whole browser layer runs on the standard library.
 *
 * Anti-detection note: we never call `Runtime.enable`. Enabling the Runtime
 * domain makes Chrome materialise a main-world execution context and emit
 * `Runtime.executionContextCreated`, which anti-bot scripts fingerprint. Plain
 * `Runtime.evaluate` on an already-attached session does not require it, so the
 * usual CDP tell is never armed.
 */

export interface CdpTargetInfo {
	targetId: string;
	type: string;
	url: string;
}

interface PendingCall {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}

export interface CdpSession {
	readonly sessionId: string;
	/** Send a protocol command scoped to this page session. */
	send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T>;
	/** Evaluate an expression in the page and return its value by value. */
	evaluate<T = unknown>(expression: string, opts?: { awaitPromise?: boolean }): Promise<T>;
	/** Navigate and resolve once the document reaches `readyState === "complete"`. */
	navigate(url: string, opts?: { timeoutMs?: number }): Promise<void>;
	/** Close this page. */
	close(): Promise<void>;
}

export class CdpError extends Error {
	readonly method?: string;

	constructor(message: string, method?: string) {
		super(message);
		this.name = "CdpError";
		this.method = method;
	}
}

export class CdpConnection {
	private readonly pending = new Map<number, PendingCall>();
	private socket: WebSocket;
	readonly browserWebSocketUrl: string;
	private nextId = 0;
	private closed = false;

	private constructor(socket: WebSocket, browserWebSocketUrl: string) {
		this.socket = socket;
		this.browserWebSocketUrl = browserWebSocketUrl;
	}

	/** Attach to a browser-level CDP endpoint. */
	static async connect(webSocketUrl: string, options: { signal?: AbortSignal } = {}): Promise<CdpConnection> {
		const socket = new WebSocket(webSocketUrl);
		await new Promise<void>((resolve, reject) => {
			const onAbort = () => reject(new CdpError("Aborted while connecting to Chrome"));
			if (options.signal?.aborted) return onAbort();
			options.signal?.addEventListener("abort", onAbort, { once: true });
			socket.onopen = () => {
				options.signal?.removeEventListener("abort", onAbort);
				resolve();
			};
			socket.onerror = () => {
				options.signal?.removeEventListener("abort", onAbort);
				reject(new CdpError(`Could not connect to Chrome at ${webSocketUrl}`));
			};
		});
		const connection = new CdpConnection(socket, webSocketUrl);
		socket.onmessage = (event) => connection.handleMessage(event.data);
		socket.onclose = () => connection.failAllPending(new CdpError("Chrome CDP socket closed"));
		return connection;
	}

	private handleMessage(raw: unknown): void {
		let message: { id?: number; result?: unknown; error?: { message?: string } };
		try {
			message = JSON.parse(typeof raw === "string" ? raw : String(raw));
		} catch {
			return;
		}
		if (typeof message.id !== "number") return; // protocol event, not a reply
		const call = this.pending.get(message.id);
		if (!call) return;
		this.pending.delete(message.id);
		if (message.error) call.reject(new CdpError(message.error.message ?? "Unknown CDP error"));
		else call.resolve(message.result);
	}

	private failAllPending(error: Error): void {
		this.closed = true;
		for (const call of this.pending.values()) call.reject(error);
		this.pending.clear();
	}

	/** Raw protocol call against the browser or a session (via `sessionId`). */
	send<T = Record<string, unknown>>(
		method: string,
		params: Record<string, unknown> = {},
		sessionId?: string,
	): Promise<T> {
		if (this.closed) return Promise.reject(new CdpError("Chrome CDP socket is closed", method));
		const id = ++this.nextId;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
			const payload = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });
			try {
				this.socket.send(payload);
			} catch (error) {
				this.pending.delete(id);
				reject(new CdpError(error instanceof Error ? error.message : String(error), method));
			}
		});
	}

	/** Open a new page and attach a flattened session to it. */
	async newPage(url = "about:blank"): Promise<CdpSession> {
		const created = await this.send<{ targetId: string }>("Target.createTarget", { url });
		const attached = await this.send<{ sessionId: string }>("Target.attachToTarget", {
			targetId: created.targetId,
			flatten: true,
		});
		return new CdpPage(this, created.targetId, attached.sessionId);
	}

	async closePage(sessionId: string, targetId: string): Promise<void> {
		try {
			await this.send("Target.closeTarget", { targetId });
		} catch {
			// Target may already be gone; closing is best-effort.
		}
		try {
			await this.send("Target.detachFromTarget", { sessionId });
		} catch {
			// Detach is best-effort.
		}
	}

	close(): void {
		this.closed = true;
		try {
			this.socket.close();
		} catch {
			// Already closed.
		}
	}
}

class CdpPage implements CdpSession {
	private readonly connection: CdpConnection;
	private readonly targetId: string;
	readonly sessionId: string;

	constructor(connection: CdpConnection, targetId: string, sessionId: string) {
		this.connection = connection;
		this.targetId = targetId;
		this.sessionId = sessionId;
	}

	send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
		return this.connection.send<T>(method, params, this.sessionId);
	}

	async evaluate<T = unknown>(expression: string, opts: { awaitPromise?: boolean } = {}): Promise<T> {
		const result = await this.send<{
			result?: { value?: T };
			exceptionDetails?: { text?: string; exception?: { description?: string } };
		}>("Runtime.evaluate", {
			expression,
			returnByValue: true,
			awaitPromise: opts.awaitPromise ?? false,
			userGesture: true,
			includeCommandLineAPI: false,
		});
		if (result.exceptionDetails) {
			const detail =
				result.exceptionDetails.exception?.description ??
				result.exceptionDetails.text ??
				"evaluation failed";
			throw new CdpError(detail, "Runtime.evaluate");
		}
		return result.result?.value as T;
	}

	async navigate(url: string, opts: { timeoutMs?: number } = {}): Promise<void> {
		const timeoutMs = opts.timeoutMs ?? 30_000;
		const deadline = Date.now() + timeoutMs;
		await this.send("Page.navigate", { url });
		// Poll readyState rather than using Page.loadEventFired: it is reliable for
		// both fast static SERPs and slow single-page shells, and needs no Page.enable.
		while (Date.now() < deadline) {
			const ready = await this.evaluate<string>("document.readyState").catch(() => "loading");
			if (ready === "complete") return;
			await sleep(100);
		}
		throw new CdpError(`Timed out navigating to ${url}`, "Page.navigate");
	}

	close(): Promise<void> {
		return this.connection.closePage(this.sessionId, this.targetId);
	}
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new CdpError("Aborted"));
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new CdpError("Aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
