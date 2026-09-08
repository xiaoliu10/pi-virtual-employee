import { normalizeTimeoutSec } from "./timeouts.js";

export interface ComputerConfig {
	enabled: boolean;
	/** Empty resolves the managed installation, then an existing local Cua installation. */
	driverPath: string;
	/** Exact app name / executable / bundle id; empty denies access, * explicitly permits all. */
	allowedApps: string[];
	allowForeground: boolean;
	allowScheduled: boolean;
	connectTimeoutSec: number;
	actionTimeoutSec: number;
	/** Whole desktop task lifetime. 0 = unlimited. */
	sessionTimeoutSec: number;
}

export const DEFAULT_COMPUTER_CONFIG: ComputerConfig = {
	enabled: false, driverPath: "", allowedApps: [], allowForeground: false,
	allowScheduled: false, connectTimeoutSec: 30, actionTimeoutSec: 120, sessionTimeoutSec: 0,
};

export function normalizeComputerConfig(value: unknown): ComputerConfig {
	const raw = value && typeof value === "object" ? value as Partial<ComputerConfig> : {};
	return {
		enabled: raw.enabled === true,
		driverPath: typeof raw.driverPath === "string" ? raw.driverPath.trim() : "",
		allowedApps: Array.isArray(raw.allowedApps) ? [...new Set(raw.allowedApps.filter((v): v is string => typeof v === "string").map(v => v.trim()).filter(Boolean))] : [],
		allowForeground: raw.allowForeground === true,
		allowScheduled: raw.allowScheduled === true,
		connectTimeoutSec: Math.max(1, normalizeTimeoutSec(raw.connectTimeoutSec, 30)),
		actionTimeoutSec: Math.max(1, normalizeTimeoutSec(raw.actionTimeoutSec, 120)),
		sessionTimeoutSec: normalizeTimeoutSec(raw.sessionTimeoutSec, 0),
	};
}

export interface ComputerStatus {
	enabled: boolean;
	connected: boolean;
	driverPath: string | null;
	serverVersion?: string;
	busy: boolean;
	install: "idle" | "downloading" | "installed" | "failed";
	installProgress?: number;
	error?: string;
}

/** Only window-scoped UI operations are exposed; no shell, clipboard, browser profile or driver config tools. */
export const COMPUTER_ACTIONS = [
	"list_apps", "list_windows", "get_window_state", "launch_app", "click", "double_click",
	"right_click", "type_text", "press_key", "hotkey", "scroll", "drag", "set_value",
] as const;
export type ComputerAction = typeof COMPUTER_ACTIONS[number];
