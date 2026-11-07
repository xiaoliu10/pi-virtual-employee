import type { AgentTool } from "@earendil-works/pi-agent-core";
import { obj, str } from "@earendil-works/pi-schema";

/** Row shape narrowed to what the tool may surface. Mirrors WorkerTaskRow. */
export interface WorkerTaskDetailRow {
	id: string;
	instruction: string;
	source_conversation: string;
	created_by: string;
	status: string;
	result: string | null;
	error: string | null;
	max_minutes: number;
	created_at: number;
	started_at: number | null;
	finished_at: number | null;
}

const STATUS_LABEL: Record<string, string> = {
	queued: "排队中",
	running: "执行中",
	done: "已完成",
	cancelled: "已取消",
	failed: "失败",
};

function fmtTime(ms: number | null): string {
	if (!ms) return "—";
	return new Date(ms).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
}

/**
 * worker_task_detail — the Chain-of-Recall second hop (context-management.md
 * §3): the conversation prefix inlines `worker:<id>` one-liners; this tool
 * pulls the FULL record when the summary is not enough. Read-only telemetry
 * (capability "telemetry", operator floor) — worker records are infrastructure
 * visibility, never user-facing task entries (user ruling 2026-11-07).
 */
export function createWorkerTaskDetailTool(getTask: (id: string) => WorkerTaskDetailRow | undefined): AgentTool<any> {
	return {
		name: "worker_task_detail",
		label: "任务执行详情",
		description:
			"查询单次对话任务（worker）的完整执行记录：原始指令、执行状态、结果或失败原因、时间线。上下文速览里的 worker:<id>、以及任务结果通知里的编号都可以用这个工具查详情。",
		parameters: obj({
			workerId: str({ description: "任务编号，如 taskA 或带前缀的 worker:taskA" }),
		}),
		async execute(_toolCallId, params) {
			const raw = (params as { workerId: string }).workerId?.trim() ?? "";
			const id = raw.replace(/^worker:/, "");
			if (!id) {
				return { content: [{ type: "text", text: "缺少任务编号。" }], details: { matched: false } };
			}
			const task = getTask(id);
			if (!task) {
				return {
					content: [{ type: "text", text: `没有找到任务 ${id}。编号以「worker:」开头的部分才是 id（例如 worker:abc123 → 查 abc123）。` }],
					details: { matched: false },
				};
			}
			const status = STATUS_LABEL[task.status] ?? task.status;
			const outcome = task.error
				? `失败原因：${task.error}`
				: task.result
					? `执行结果：${task.result}`
					: "尚无结果";
			const text = [
				`任务 ${task.id}（${status}）`,
				`指令：${task.instruction}`,
				outcome,
				`来源会话：${task.source_conversation}（结果也推送回该会话）`,
				`发起人：${task.created_by}`,
				`时间线：创建 ${fmtTime(task.created_at)}｜开始 ${fmtTime(task.started_at)}｜结束 ${fmtTime(task.finished_at)}`,
			].join("\n");
			return {
				content: [{ type: "text", text }],
				details: { matched: true, id: task.id, status: task.status },
			};
		},
	};
}
