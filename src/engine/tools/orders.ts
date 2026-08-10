import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

interface OrderRecord {
	status: "待发货" | "已发货" | "已签收" | "已取消";
	amount: number;
	tracking?: string;
	placedAt: string;
}

/** Demo order store. Replace with a real order service / DB in production. */
const ORDERS: Record<string, OrderRecord> = {
	"A10001": { status: "已发货", amount: 129, tracking: "SF1234567890", placedAt: "2026-07-25" },
	"A10002": { status: "待发货", amount: 59, placedAt: "2026-07-27" },
	"A10003": { status: "已签收", amount: 299, tracking: "YT9876543210", placedAt: "2026-07-18" },
};

export const orderTool: AgentTool = {
	name: "lookup_order",
	label: "订单查询",
	description:
		"根据订单号查询订单状态、物流单号、金额和下单时间。当客户提到订单号或询问订单进度时调用。",
	parameters: Type.Object({
		orderId: Type.String({ description: "订单编号,例如 A10001" }),
	}),
	async execute(_toolCallId, params) {
		const { orderId } = params as { orderId: string };
		const order = ORDERS[orderId];
		if (!order) {
			return {
				content: [{ type: "text", text: `未找到订单号 ${orderId},请和客户确认订单号是否正确。` }],
				details: { found: false, orderId },
			};
		}
		const lines = [
			`订单号: ${orderId}`,
			`状态: ${order.status}`,
			`金额: ¥${order.amount}`,
			`下单时间: ${order.placedAt}`,
			order.tracking ? `物流单号: ${order.tracking}` : "物流单号: 暂无(尚未发货)",
		];
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { found: true, orderId, order },
		};
	},
};
