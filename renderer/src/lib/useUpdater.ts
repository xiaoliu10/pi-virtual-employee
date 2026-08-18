/**
 * Renderer-side updater state. Pulls "update:getState" on mount (the startup
 * check fires ~15s in, before this component may subscribe) and subscribes to
 * "update:event" pushes. Every action returns the fresh state so callers can
 * ignore it — the push is the single source of truth for the UI.
 */
import { useEffect, useState } from "react";
import type { UpdateState } from "./types";
import { api } from "./ipc";

export function useUpdater(): {
	state: UpdateState | null;
	check: () => void;
	download: () => void;
	install: () => void;
} {
	const [state, setState] = useState<UpdateState | null>(null);

	useEffect(() => {
		let alive = true;
		void api.getUpdateState().then((s) => {
			if (alive) setState(s);
		});
		const unsubscribe = api.onUpdateEvent((s) => setState(s));
		return () => {
			alive = false;
			unsubscribe();
		};
	}, []);

	return {
		state,
		check: () => {
			void api.checkForUpdates().then((s) => setState(s));
		},
		download: () => {
			void api.downloadUpdate().then((s) => setState(s));
		},
		install: () => {
			void api.installUpdate();
		},
	};
}
