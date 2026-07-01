const endpoint = "/api/pi-client/pi-server";
const agentsEndpoint = "/api/pi-client/global-agents";
const projectsEndpoint = "/api/pi-client/projects";

function definePiClientServerElements() {
	if (customElements.get("pi-client-server-panel") !== undefined) return;

	class PiClientServerPanel extends HTMLElement {
		connectedCallback() {
			if (this.eventsBound !== true) {
				this.eventsBound = true;
				this.addEventListener("click", (event) => {
					const path = event.composedPath();
					if (path.some((node) => typeof node?.getAttribute === "function" && node.getAttribute("data-save") !== null)) void this.save(event);
					if (path.some((node) => typeof node?.getAttribute === "function" && node.getAttribute("data-refresh") !== null)) void this.load();
				});
				this.addEventListener("submit", (event) => this.save(event));
			}
			this.load();
		}

		async load() {
			this.state = { loading: true };
			this.render();
			try {
				const response = await fetch(endpoint);
				if (!response.ok) throw new Error(response.statusText);
				this.state = { data: await response.json() };
			} catch (error) {
				this.state = { error: error instanceof Error ? error.message : String(error) };
			}
			this.render();
		}

		async save(event) {
			event?.preventDefault();
			const input = this.querySelector("input[name='piServerUrl']");
			if (typeof input?.value !== "string") return;
			this.state = { ...this.state, saving: true };
			this.render();
			try {
				const response = await fetch(endpoint, {
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ piServerUrl: input.value }),
				});
				if (!response.ok) throw new Error((await response.json()).error ?? response.statusText);
				this.state = { data: await response.json(), saved: true };
			} catch (error) {
				this.state = { ...this.state, error: error instanceof Error ? error.message : String(error) };
			}
			this.render();
		}

		render() {
			const data = this.state?.data;
			const ready = data?.reachable === true && data?.authenticated !== false;
			const dot = data === undefined ? "unknown" : ready ? "ok" : "bad";
			this.innerHTML = `
				<style>
					pi-client-server-panel { display: block; color: var(--pi-text); }
					.pi-client-server-panel { display: grid; gap: 12px; padding: 12px; }
					.pi-client-server-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
					.pi-client-server-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--pi-muted); flex: 0 0 auto; }
					.pi-client-server-dot.ok { background: #2ea043; }
					.pi-client-server-dot.bad { background: #f85149; }
					.pi-client-server-panel input { width: 100%; box-sizing: border-box; border: 1px solid var(--pi-border); border-radius: 6px; background: var(--pi-bg); color: var(--pi-text); padding: 8px; }
					.pi-client-server-panel button { border: 1px solid var(--pi-border); border-radius: 6px; background: var(--pi-surface); color: var(--pi-text); padding: 7px 10px; cursor: pointer; }
					.pi-client-server-panel button.primary { border-color: var(--pi-accent-border); color: var(--pi-text-bright); }
					.pi-client-server-panel small, .pi-client-server-panel .muted { color: var(--pi-muted); }
					.pi-client-server-panel form { display: grid; gap: 8px; }
					.pi-client-server-actions { display: flex; gap: 8px; flex-wrap: wrap; }
				</style>
				<div class="pi-client-server-panel">
					<div class="pi-client-server-row"><span class="pi-client-server-dot ${dot}"></span><strong>pi-server</strong><small>${escapeHtml(statusText(this.state))}</small></div>
					<form>
						<label>
							<small>Server URL</small>
							<input name="piServerUrl" value="${escapeAttr(data?.serverUrl ?? "")}" placeholder="http://127.0.0.1:4217" />
						</label>
						<div class="pi-client-server-actions">
							<button class="primary" type="button" data-save>${this.state?.saving === true ? "Saving..." : "Save"}</button>
							<button type="button" data-refresh>Refresh</button>
						</div>
					</form>
					<small>URL source: ${escapeHtml(data?.urlSource ?? "unknown")} · token: ${data?.tokenConfigured === true ? "configured" : "not configured"}</small>
					${data?.restartRequired === true ? `<small>Restart pi-client web for saved server URL changes to affect new sessions.</small>` : ""}
					${this.state?.saved === true ? `<small>Saved.</small>` : ""}
					${this.state?.error === undefined ? "" : `<small>${escapeHtml(this.state.error)}</small>`}
				</div>
			`;
		}
	}

	class PiClientServerDialog extends HTMLElement {
		connectedCallback() {
			this.render();
		}

		render() {
			this.innerHTML = `
				<style>
					.pi-client-server-backdrop { position: fixed; inset: 0; z-index: 10000; display: grid; place-items: center; background: rgb(0 0 0 / 0.5); }
					.pi-client-server-dialog { width: min(520px, calc(100vw - 32px)); border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-bg); box-shadow: 0 20px 60px rgb(0 0 0 / 0.35); overflow: hidden; }
					.pi-client-server-dialog header { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border-bottom: 1px solid var(--pi-border); }
					.pi-client-server-dialog button { border: 1px solid var(--pi-border); border-radius: 6px; background: var(--pi-surface); color: var(--pi-text); padding: 5px 9px; cursor: pointer; }
				</style>
				<div class="pi-client-server-backdrop">
					<section class="pi-client-server-dialog">
						<header><strong>Pi Server Settings</strong><button type="button" data-close>Close</button></header>
						<pi-client-server-panel></pi-client-server-panel>
					</section>
				</div>
			`;
			this.querySelector("[data-close]")?.addEventListener("click", () => this.remove());
			this.querySelector(".pi-client-server-backdrop")?.addEventListener("click", (event) => {
				if (event.target === event.currentTarget) this.remove();
			});
		}
	}

	class PiClientServerBadge extends HTMLElement {
		connectedCallback() {
			if (this.shadowRoot === null) this.attachShadow({ mode: "open" });
			this.load();
			window.addEventListener("focus", this);
		}

		disconnectedCallback() {
			window.removeEventListener("focus", this);
		}

		handleEvent() {
			this.load();
		}

		async load() {
			try {
				const response = await fetch(endpoint);
				this.data = response.ok ? await response.json() : { reachable: false };
			} catch {
				this.data = { reachable: false };
			}
			this.render();
		}

		render() {
			const ok = this.data?.reachable === true && this.data?.authenticated !== false;
			this.shadowRoot.innerHTML = `
				<style>
					:host { position: fixed; right: 12px; bottom: 10px; z-index: 1000; }
					button { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--pi-border); border-radius: 999px; background: var(--pi-bg); color: var(--pi-muted); padding: 5px 9px; font-size: 12px; cursor: pointer; }
					.dot { width: 8px; height: 8px; border-radius: 50%; background: ${ok ? "#2ea043" : "#f85149"}; }
				</style>
				<button type="button" title="Pi Server Settings"><span class="dot"></span>pi-server</button>
			`;
			this.shadowRoot.querySelector("button")?.addEventListener("click", () => openPiClientServerDialog());
		}
	}

	class PiClientAgentsDialog extends HTMLElement {
		connectedCallback() {
			if (this.eventsBound !== true) {
				this.eventsBound = true;
				this.addEventListener("click", (event) => {
					const path = event.composedPath();
					if (path.some((node) => typeof node?.getAttribute === "function" && node.getAttribute("data-close") !== null)) this.remove();
					if (path.some((node) => typeof node?.getAttribute === "function" && node.getAttribute("data-save-agents") !== null)) void this.save(event);
				});
				this.addEventListener("submit", (event) => this.save(event));
			}
			this.load();
		}

		async load() {
			this.state = { loading: true };
			this.render();
			const response = await fetch(agentsEndpoint);
			if (!response.ok) throw new Error(response.statusText);
			this.state = { data: await response.json() };
			this.render();
		}

		async save(event) {
			event?.preventDefault();
			const textarea = this.querySelector("textarea[name='content']");
			if (typeof textarea?.value !== "string") return;
			this.state = { ...this.state, saving: true };
			this.render();
			const response = await fetch(agentsEndpoint, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ content: textarea.value }),
			});
			if (!response.ok) throw new Error((await response.json()).error ?? response.statusText);
			this.state = { data: await response.json(), saved: true };
			this.render();
		}

		render() {
			const data = this.state?.data;
			this.innerHTML = `
				<style>
					.pi-client-agents-backdrop { position: fixed; inset: 0; z-index: 10000; display: grid; place-items: center; background: rgb(0 0 0 / 0.5); }
					.pi-client-agents-dialog { width: min(840px, calc(100vw - 32px)); max-height: calc(100vh - 32px); display: grid; grid-template-rows: auto minmax(0, 1fr) auto; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-bg); box-shadow: 0 20px 60px rgb(0 0 0 / 0.35); overflow: hidden; color: var(--pi-text); }
					.pi-client-agents-dialog header, .pi-client-agents-dialog footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--pi-border); }
					.pi-client-agents-dialog footer { border-top: 1px solid var(--pi-border); border-bottom: 0; }
					.pi-client-agents-dialog button { border: 1px solid var(--pi-border); border-radius: 6px; background: var(--pi-surface); color: var(--pi-text); padding: 6px 10px; cursor: pointer; }
					.pi-client-agents-dialog button.primary { border-color: var(--pi-accent-border); color: var(--pi-text-bright); }
					.pi-client-agents-dialog small { color: var(--pi-muted); overflow-wrap: anywhere; }
					.pi-client-agents-dialog textarea { width: 100%; min-height: 420px; height: min(56vh, 640px); resize: vertical; box-sizing: border-box; border: 0; border-bottom: 1px solid var(--pi-border); background: var(--pi-terminal-bg, var(--pi-bg)); color: var(--pi-terminal-text, var(--pi-text)); padding: 12px; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; }
					.pi-client-agents-body { min-height: 0; }
					.pi-client-agents-actions { display: flex; gap: 8px; align-items: center; }
				</style>
				<div class="pi-client-agents-backdrop">
					<form class="pi-client-agents-dialog">
						<header><strong>Global AGENTS.md</strong><button type="button" data-close>Close</button></header>
						<div class="pi-client-agents-body">
							<textarea name="content" spellcheck="false" ${this.state?.loading === true ? "disabled" : ""}>${escapeHtml(data?.content ?? "")}</textarea>
						</div>
						<footer>
							<small>${escapeHtml(data?.path ?? "Loading...")}</small>
							<div class="pi-client-agents-actions">
								${this.state?.saved === true ? `<small>Saved.</small>` : ""}
								<button class="primary" type="button" data-save-agents>${this.state?.saving === true ? "Saving..." : "Save"}</button>
							</div>
						</footer>
					</form>
				</div>
			`;
			this.querySelector(".pi-client-agents-backdrop")?.addEventListener("click", (event) => {
				if (event.target === event.currentTarget) this.remove();
			});
		}
	}

	class PiClientProjectsDialog extends HTMLElement {
		connectedCallback() {
			if (this.eventsBound !== true) {
				this.eventsBound = true;
				this.addEventListener("click", (event) => {
					const path = event.composedPath();
					if (path.some((node) => typeof node?.getAttribute === "function" && node.getAttribute("data-close") !== null)) this.remove();
					const button = path.find((node) => typeof node?.getAttribute === "function" && node.getAttribute("data-project-id") !== null);
					if (button !== undefined) void this.setVisibility(button.getAttribute("data-project-id"), button.getAttribute("data-visible") === "true");
				});
			}
			this.load();
		}

		async load() {
			this.state = { loading: true };
			this.render();
			const response = await fetch(projectsEndpoint);
			if (!response.ok) throw new Error(response.statusText);
			this.state = { projects: await response.json() };
			this.render();
		}

		async setVisibility(projectId, visible) {
			this.state = { ...this.state, saving: projectId };
			this.render();
			const response = await fetch(`${projectsEndpoint}/${encodeURIComponent(projectId)}/visibility`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ visible }),
			});
			if (!response.ok) throw new Error((await response.json()).error ?? response.statusText);
			this.state = { projects: await response.json(), saved: true };
			this.render();
		}

		render() {
			const projects = this.state?.projects ?? [];
			this.innerHTML = `
				<style>
					.pi-client-projects-backdrop { position: fixed; inset: 0; z-index: 10000; display: grid; place-items: center; background: rgb(0 0 0 / 0.5); }
					.pi-client-projects-dialog { width: min(720px, calc(100vw - 32px)); max-height: calc(100vh - 32px); display: grid; grid-template-rows: auto minmax(0, 1fr) auto; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-bg); box-shadow: 0 20px 60px rgb(0 0 0 / 0.35); overflow: hidden; color: var(--pi-text); }
					.pi-client-projects-dialog header, .pi-client-projects-dialog footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--pi-border); }
					.pi-client-projects-dialog footer { border-top: 1px solid var(--pi-border); border-bottom: 0; }
					.pi-client-projects-dialog button { border: 1px solid var(--pi-border); border-radius: 6px; background: var(--pi-surface); color: var(--pi-text); padding: 6px 10px; cursor: pointer; }
					.pi-client-projects-dialog small { color: var(--pi-muted); overflow-wrap: anywhere; }
					.pi-client-projects-list { overflow: auto; }
					.pi-client-project-row { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 10px; align-items: center; padding: 10px 12px; border-bottom: 1px solid var(--pi-border-muted, var(--pi-border)); }
					.pi-client-project-row strong { display: block; }
					.pi-client-project-empty { padding: 18px 12px; color: var(--pi-muted); }
				</style>
				<div class="pi-client-projects-backdrop">
					<section class="pi-client-projects-dialog">
						<header><strong>Project Visibility</strong><button type="button" data-close>Close</button></header>
						<div class="pi-client-projects-list">
							${
								this.state?.loading === true
									? `<div class="pi-client-project-empty">Loading...</div>`
									: projects.length === 0
										? `<div class="pi-client-project-empty">No projects yet.</div>`
										: projects.map((project) => projectRow(project, this.state?.saving)).join("")
							}
						</div>
						<footer><small>Visible projects appear in the PI WEB sidebar.</small>${this.state?.saved === true ? `<small>Saved.</small>` : ""}</footer>
					</section>
				</div>
			`;
			this.querySelector(".pi-client-projects-backdrop")?.addEventListener("click", (event) => {
				if (event.target === event.currentTarget) this.remove();
			});
		}
	}

	class PiClientQuickbar extends HTMLElement {
		connectedCallback() {
			if (this.shadowRoot === null) this.attachShadow({ mode: "open" });
			this.render();
		}

		render() {
			this.shadowRoot.innerHTML = `
				<style>
					:host { display: block; border-bottom: 1px solid var(--pi-border); padding: 8px 10px; }
					.pi-client-quickbar { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; }
					button { min-width: 0; border: 1px solid var(--pi-border); border-radius: 6px; background: var(--pi-surface); color: var(--pi-text); padding: 6px 4px; font-size: 12px; line-height: 1; cursor: pointer; }
				</style>
				<div class="pi-client-quickbar">
					<button type="button" title="New Conversation" data-action="new">New</button>
					<button type="button" title="Search" data-action="search">Search</button>
					<button type="button" title="Skill Management" data-action="skills">Skills</button>
					<button type="button" title="Global AGENTS.md" data-action="agents">AGENTS</button>
				</div>
			`;
			this.shadowRoot.querySelectorAll("button").forEach((button) => {
				button.addEventListener("click", () => runQuickbarAction(button.getAttribute("data-action")));
			});
		}
	}

	customElements.define("pi-client-server-panel", PiClientServerPanel);
	customElements.define("pi-client-server-dialog", PiClientServerDialog);
	customElements.define("pi-client-server-badge", PiClientServerBadge);
	customElements.define("pi-client-agents-dialog", PiClientAgentsDialog);
	customElements.define("pi-client-projects-dialog", PiClientProjectsDialog);
	customElements.define("pi-client-quickbar", PiClientQuickbar);
}

function openPiClientServerDialog() {
	document.querySelector("pi-client-server-dialog")?.remove();
	document.body.append(document.createElement("pi-client-server-dialog"));
}

function openPiClientAgentsDialog() {
	document.querySelector("pi-client-agents-dialog")?.remove();
	document.body.append(document.createElement("pi-client-agents-dialog"));
}

function openPiClientProjectsDialog() {
	document.querySelector("pi-client-projects-dialog")?.remove();
	document.body.append(document.createElement("pi-client-projects-dialog"));
}

function installBadge() {
	if (document.querySelector("pi-client-server-badge") !== null) return;
	document.body.append(document.createElement("pi-client-server-badge"));
}

function installQuickbar() {
	const root = document.querySelector("pi-web-app")?.shadowRoot?.querySelector("app-navigation-panel")?.shadowRoot;
	if (root === undefined || root === null) {
		window.requestAnimationFrame(installQuickbar);
		return;
	}
	if (root.querySelector("pi-client-quickbar") === null) root.querySelector("header")?.after(document.createElement("pi-client-quickbar"));
	if (window.piClientQuickbarObserver !== undefined) return;
	window.piClientQuickbarObserver = new MutationObserver(() => {
		if (root.querySelector("pi-client-quickbar") === null) root.querySelector("header")?.after(document.createElement("pi-client-quickbar"));
	});
	window.piClientQuickbarObserver.observe(root, { childList: true });
}

function runQuickbarAction(action) {
	const context = piWebContext();
	if (action === "new") {
		if (context.state.selectedWorkspace === undefined) {
			context.addProject();
		} else {
			void context.startSession();
		}
	}
	if (action === "search") context.openActionPalette();
	if (action === "skills") context.piWebUnstable.openSettings("plugins");
	if (action === "agents") openPiClientAgentsDialog();
}

function piWebContext() {
	// ponytail: PI WEB exposes runtime helpers to actions but not fixed toolbar slots yet.
	return document.querySelector("pi-web-app").createPluginRuntimeContext();
}

function projectRow(project, savingProjectId) {
	const visible = project.hidden !== true;
	const saving = savingProjectId === project.id;
	return `
		<div class="pi-client-project-row">
			<div>
				<strong>${escapeHtml(project.name)}</strong>
				<small>${escapeHtml(project.path)}</small>
			</div>
			<small>${visible ? "Visible" : "Hidden"}</small>
			<button type="button" data-project-id="${escapeAttr(project.id)}" data-visible="${visible ? "false" : "true"}">${saving ? "Saving..." : visible ? "Hide" : "Show"}</button>
		</div>
	`;
}

function statusText(state) {
	if (state?.loading === true) return "checking";
	if (state?.error !== undefined) return state.error;
	if (state?.data === undefined) return "unknown";
	if (state.data.reachable !== true) return "offline";
	if (state.data.authenticated === false) return "auth failed";
	return "online";
}

function escapeHtml(value) {
	return String(value).replace(/[&<>"']/gu, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function escapeAttr(value) {
	return escapeHtml(value);
}

const plugin = {
	apiVersion: 1,
	name: "pi-client",
	activate: ({ html, svg }) => {
		definePiClientServerElements();
		queueMicrotask(installBadge);
		queueMicrotask(installQuickbar);
		return {
			contributions: {
				actions: [
					{
						id: "pi-client.add-project",
						title: "Add Project",
						description: "Add a local folder to the pi-client web sidebar.",
						group: "Pi Client",
						run: (context) => context.addProject(),
					},
					{
						id: "pi-client.new-conversation",
						title: "New Conversation",
						description: "Start a new pi-client session in the selected workspace.",
						group: "Pi Client",
						enabled: (context) => context.state.selectedWorkspace !== undefined,
						disabledReason: () => "Select a workspace first.",
						run: (context) => context.startSession(),
					},
					{
						id: "pi-client.search",
						title: "Search",
						description: "Open PI WEB's action search.",
						group: "Pi Client",
						run: (context) => context.openActionPalette(),
					},
					{
						id: "pi-client.skill-management",
						title: "Skill Management",
						description: "Open PI WEB plugin management.",
						group: "Pi Client",
						run: (context) => context.piWebUnstable.openSettings("plugins"),
					},
					{
						id: "pi-client.project-visibility",
						title: "Project Visibility",
						description: "Hide or show projects in the pi-client web sidebar.",
						group: "Pi Client",
						run: openPiClientProjectsDialog,
					},
					{
						id: "pi-client.global-agents",
						title: "Global AGENTS.md",
						description: "Edit the shared pi-client AGENTS.md file.",
						group: "Pi Client",
						run: openPiClientAgentsDialog,
					},
					{
						id: "pi-client.open-pi-server-settings",
						title: "Pi Server Settings",
						description: "Configure the pi-server URL used by pi-client web sessions.",
						group: "Pi Client",
						run: openPiClientServerDialog,
					},
				],
				workspacePanels: [
					{
						id: "pi-client.server",
						title: "Pi Server",
						icon: svg`
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<path d="M12 2v6"></path>
								<path d="M12 16v6"></path>
								<path d="M4.9 4.9l4.2 4.2"></path>
								<path d="M14.9 14.9l4.2 4.2"></path>
								<path d="M2 12h6"></path>
								<path d="M16 12h6"></path>
								<circle cx="12" cy="12" r="4"></circle>
							</svg>
						`,
						order: 5,
						render: () => html`<pi-client-server-panel></pi-client-server-panel>`,
					},
				],
			},
		};
	},
};

export default plugin;
