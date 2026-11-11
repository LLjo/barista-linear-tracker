import { definePlugin } from "@barista/plugin-sdk";
import type { AppType } from "./server/routes.js";

export default definePlugin<AppType>(import.meta.dirname);
