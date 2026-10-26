import type { ViewerSubagent } from "../src/viewer-types.ts";
import { Icon } from "./icons.tsx";
import { Status } from "./projects.tsx";

const outcomeLabels = { completed: "已完成", failed: "失败", aborted: "已中止" };

export function Subagents({ agents, select }: { agents: ViewerSubagent[]; select: (id: string) => void }) {
	const active: ViewerSubagent[] = [];
	const completed: ViewerSubagent[] = [];
	for (const agent of agents) (agent.lifecycle === "completed" ? completed : active).push(agent);
	return (
		<aside className="subagents-panel" id="subagents-panel" aria-label="子代理">
			<div className="subagents-heading">
				<Icon name="spark" size={16} />
				<h2>子代理</h2>
				<span>{agents.length}</span>
			</div>
			<div className="subagents-scroll">
				{[
					{ label: "活动中", agents: active },
					{ label: "已完成", agents: completed },
				].map((group) => (
					<section className="subagents-group" key={group.label} aria-label={group.label}>
						<h3>
							{group.label} <span>{group.agents.length}</span>
						</h3>
						{group.agents.length ? (
							group.agents.map((agent) => (
								<button type="button" className="subagent-row" key={agent.id} onClick={() => select(agent.id)}>
									<span className="subagent-title">{agent.title}</span>
									{agent.lifecycle === "completed" ? (
										<span className={`subagent-outcome ${agent.outcome ?? "completed"}`}>
											{agent.outcome ? outcomeLabels[agent.outcome] : "已完成"}
										</span>
									) : (
										<Status status={agent.status} text />
									)}
								</button>
							))
						) : (
							<p className="subagents-empty">暂无{group.label}的子代理</p>
						)}
					</section>
				))}
			</div>
		</aside>
	);
}
