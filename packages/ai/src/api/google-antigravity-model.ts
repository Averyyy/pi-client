/**
 * Antigravity catalogs list one runtime model per reasoning effort. Discovery groups them
 * into one pi model and carries the per-effort wire routes on the model object.
 */

import type { Model } from "../types.ts";

/** Reasoning-effort suffixes the Antigravity catalog uses in runtime model ids. */
export type AntigravityRouteLevel = "low" | "medium" | "high" | "xhigh";

/** One wire route: the runtime model id and the catalog's model enum for request labels. */
export interface AntigravityRoute {
	runtimeId: string;
	modelEnum?: string;
}

/** Wire routes behind one pi model, one per supported reasoning effort. */
export interface AntigravityRoutes {
	default: AntigravityRoute;
	levels: Partial<Record<AntigravityRouteLevel, AntigravityRoute>>;
}

/** A discovered Antigravity model carrying the wire routes for its effort variants. */
export interface GoogleAntigravityModel extends Model<"google-antigravity"> {
	antigravityRoutes?: AntigravityRoutes;
}

/** Read the wire routes discovery attached; caller-supplied models have none. */
export function antigravityRoutes(model: Model<"google-antigravity">): AntigravityRoutes | undefined {
	// Discovery is the only producer of these models; the field is absent on manual models.
	return (model as GoogleAntigravityModel).antigravityRoutes;
}
