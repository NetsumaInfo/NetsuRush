/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as access from "../access.js";
import type * as audit from "../audit.js";
import type * as auth from "../auth.js";
import type * as bugs from "../bugs.js";
import type * as collabPolicy from "../collabPolicy.js";
import type * as devices from "../devices.js";
import type * as discord from "../discord.js";
import type * as downloads from "../downloads.js";
import type * as heads from "../heads.js";
import type * as http from "../http.js";
import type * as ideas from "../ideas.js";
import type * as media from "../media.js";
import type * as projects from "../projects.js";
import type * as site from "../site.js";
import type * as social from "../social.js";
import type * as waitlist from "../waitlist.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  access: typeof access;
  audit: typeof audit;
  auth: typeof auth;
  bugs: typeof bugs;
  collabPolicy: typeof collabPolicy;
  devices: typeof devices;
  discord: typeof discord;
  downloads: typeof downloads;
  heads: typeof heads;
  http: typeof http;
  ideas: typeof ideas;
  media: typeof media;
  projects: typeof projects;
  site: typeof site;
  social: typeof social;
  waitlist: typeof waitlist;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  betterAuth: import("@convex-dev/better-auth/_generated/component.js").ComponentApi<"betterAuth">;
};
