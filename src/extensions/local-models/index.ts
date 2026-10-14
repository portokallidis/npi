import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { localProviders } from "../../core/localmodels.ts";

/** Registers local/self-hosted model servers from .env (see src/core/localmodels.ts). */
export default async function localModels(pi: ExtensionAPI) {
	for (const { name, config } of await localProviders()) pi.registerProvider(name, config);
}
