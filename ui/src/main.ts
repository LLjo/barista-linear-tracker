import { mount } from "svelte";
import App from "./App.svelte";
// The one theme: tokens + fonts first, this UI's own rules over them.
import "@barista/plugin-sdk/ui/theme.css";
import "./app.css";

// The same page answers the plugin's own tab and the shell's Settings › Linear frame (`view=settings`).
const app = mount(App, { target: document.getElementById("app")! });

export default app;
