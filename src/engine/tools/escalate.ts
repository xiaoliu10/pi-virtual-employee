import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

export const escalateTool: AgentTool = {
	name: "escalate_to_human",
	label: "转人工",
	description:
		"创建一张人工客服工单并结束本次自动应答。在以下情况调用:问题超出处理范围、客户情绪激动或多次不满、客户明确要求人工。",
	parameters: Type.Object({
		reason: Type.String({ description: "转人工的原因,简要说明客户的问题" }),
	}),
	async execute(_toolCallId, params) {
		const { reason } = params as { reason: string };
		const ticketId = `T-${Date.now().toString(36).toUpperCase()}`;
		const text = `已为你创建人工工单 ${ticketId}。原因:${reason}。人工客服预计 5 分钟内接入,请保持会话。`;
		// `terminate: true` tells the agent loop to stop after this tool batch,
		// so the agent hands off cleanly instead of looping on the escalation.
		return {
			content: [{ type: "text", text }],
			details: { reason, ticketId },
			terminate: true,
		};
	},
};
