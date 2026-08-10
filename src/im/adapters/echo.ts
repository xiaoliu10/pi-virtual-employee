/**
 * Echo adapter — a no-network IM channel used to exercise the full IM pipeline
 * (inbound → employee → reply) without a real platform. It exposes `simulate()`
 * as a test/debug entry point that behaves like an incoming IM message.
 */
import type { IMAdapter, IMConfig, IMIO } from "../types.js";

export class EchoAdapter implements IMAdapter {
	readonly channel = "echo";
	private io?: IMIO;

	async start(io: IMIO, _config: IMConfig): Promise<void> {
		this.io = io;
		console.log("[im:echo] adapter started (test channel)");
	}

	async stop(): Promise<void> {
		this.io = undefined;
	}

	/** Simulate an inbound IM message; returns the employee reply. */
	async simulate(conversationId: string, text: string): Promise<string> {
		if (!this.io) throw new Error("echo adapter not started");
		return this.io.handle({ conversationId, text });
	}
}
