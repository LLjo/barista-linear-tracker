<script lang="ts">
	import * as api from "./lib/api.js";
	import type { WorkspacePublic } from "./lib/api.js";

	let workspaces = $state<WorkspacePublic[] | null>(null);
	let loadError = $state<string | null>(null);
	// A key is write-only: it lives in an input until sent, then the input is cleared. Nothing echoes it back.
	let draft = $state("");
	let error = $state<string | null>(null);
	let busy = $state(false);
	let replacing = $state<string | null>(null);
	let replaceDraft = $state("");
	let replaceError = $state<string | null>(null);

	async function load() {
		try {
			workspaces = (await api.listWorkspaces()).workspaces;
			loadError = null;
		} catch (e) {
			loadError = (e as Error).message;
		}
	}
	load();

	async function add() {
		if (!draft.trim() || busy) return;
		busy = true;
		try {
			await api.addKey(draft.trim());
			draft = "";
			error = null;
			await load();
		} catch (e) {
			error = (e as Error).message;
		} finally {
			busy = false;
		}
	}

	async function replace(id: string) {
		if (!replaceDraft.trim() || busy) return;
		busy = true;
		try {
			await api.replaceKey(id, replaceDraft.trim());
			replacing = null;
			replaceDraft = "";
			replaceError = null;
			await load();
		} catch (e) {
			replaceError = (e as Error).message;
		} finally {
			busy = false;
		}
	}

	async function remove(w: WorkspacePublic) {
		if (!confirm(`Remove ${w.name}? Its key is deleted from this host, and projects tracked in it stop filing.`)) return;
		try {
			await api.removeWorkspace(w.id);
			await load();
		} catch (e) {
			error = (e as Error).message;
		}
	}

	const sub = (w: WorkspacePublic) =>
		[w.urlKey, `signed in as ${w.viewerName}`, `key ••••${w.keyLast4}`].join(" · ");
</script>

<h1>Linear</h1>
<p class="lead">Keys the Linear tracker files issues with. Pick a workspace and team per project in <b>Settings › Project</b>.</p>

{#if loadError}<div class="err">{loadError}</div>{/if}

<section>
	<h2>Workspaces</h2>
	{#if workspaces && workspaces.length === 0}<p class="empty">No workspace yet. Add a key below.</p>{/if}
	{#each workspaces ?? [] as w (w.id)}
		<div class="ws">
			<span class="name">{w.name}</span>
			<span class="sub">{sub(w)}</span>
			<span class="side">
				{#if w.status === "rejected"}<span class="chip bad">✕ key rejected</span>{:else}<span class="chip ok">✓ working</span>{/if}
				<button type="button" onclick={() => { replacing = replacing === w.id ? null : w.id; replaceError = null; }}>Replace key</button>
				<button type="button" onclick={() => remove(w)}>Remove</button>
			</span>
			{#if replacing === w.id}
				<div class="add wide">
					<input type="password" placeholder="Paste a new key for {w.name}" autocomplete="off" bind:value={replaceDraft}
						onkeydown={(e) => e.key === "Enter" && replace(w.id)} />
					<button type="button" class="go" disabled={busy} onclick={() => replace(w.id)}>Save</button>
				</div>
				{#if replaceError}<div class="err wide">{replaceError}</div>{/if}
			{/if}
		</div>
	{/each}

	<h2>Add a workspace</h2>
	<div class="add">
		<input type="password" placeholder="Paste a Linear personal API key" autocomplete="off" bind:value={draft}
			onkeydown={(e) => e.key === "Enter" && add()} />
		<button type="button" class="go" disabled={busy} onclick={add}>Add</button>
	</div>
	{#if error}<div class="err">{error}</div>{/if}
	<p class="help">
		Create a key in Linear: <b>Settings → Security &amp; access → Personal API keys</b>. It needs <b>write</b> access:
		Barista creates, edits, closes and re-parents issues with it. One key per workspace.<br />
		The key is stored on this Barista host only. It is never shown again, never logged and never sent to the browser; only its last 4 characters are.
	</p>
</section>

<style>
	h1 { margin: 0; font: 600 var(--t-l) var(--display); }
	.lead { margin: 4px 0 0; color: var(--ink-3); font-size: var(--t-s); }
	section { max-width: 640px; margin-top: 16px; display: flex; flex-direction: column; gap: 12px; }
	h2 { margin: 0; font: 600 var(--t-m) var(--sans); color: var(--ink-2); }
	.ws { display: grid; grid-template-columns: 1fr auto; gap: 4px 12px; align-items: center; padding: 10px 12px; border-radius: var(--r-sm); background: var(--raised); }
	.name { font-weight: 500; }
	.sub { grid-column: 1; color: var(--ink-3); font-size: var(--t-xs); font-family: var(--mono); }
	.side { grid-row: 1 / span 2; grid-column: 2; display: flex; gap: 10px; align-items: center; font-size: var(--t-s); }
	.side button { padding: 0; border: 0; background: none; color: var(--ink-3); cursor: pointer; }
	.side button:hover { color: var(--link); }
	.wide { grid-column: 1 / -1; }
	.add { display: flex; gap: 8px; align-items: center; }
	.add input { flex: 1; font-family: var(--mono); }
	.go { background: var(--accent); color: var(--on-accent); border: 0; border-radius: var(--r-pill); padding: 4px 14px; font-weight: 600; cursor: pointer; }
	.go:disabled { opacity: .6; cursor: default; }
	.help, .empty { margin: 0; color: var(--ink-3); font-size: var(--t-s); line-height: 1.6; }
	.err { color: var(--fail-fg); font-size: var(--t-s); }
</style>
