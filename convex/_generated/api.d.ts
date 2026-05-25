/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as admin from "../admin.js";
import type * as draftReply from "../draftReply.js";
import type * as emailBody from "../emailBody.js";
import type * as emails from "../emails.js";
import type * as emailsInternal from "../emailsInternal.js";
import type * as inbox from "../inbox.js";
import type * as lib_clerkBackend from "../lib/clerkBackend.js";
import type * as lib_gmail from "../lib/gmail.js";
import type * as lib_limits from "../lib/limits.js";
import type * as lib_llm from "../lib/llm.js";
import type * as lib_replyType from "../lib/replyType.js";
import type * as llm from "../llm.js";
import type * as prompts_classify from "../prompts/classify.js";
import type * as prompts_classifySegment from "../prompts/classifySegment.js";
import type * as prompts_draftReply from "../prompts/draftReply.js";
import type * as sendReply from "../sendReply.js";
import type * as sentMail from "../sentMail.js";
import type * as users from "../users.js";
import type * as voiceSamples from "../voiceSamples.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  admin: typeof admin;
  draftReply: typeof draftReply;
  emailBody: typeof emailBody;
  emails: typeof emails;
  emailsInternal: typeof emailsInternal;
  inbox: typeof inbox;
  "lib/clerkBackend": typeof lib_clerkBackend;
  "lib/gmail": typeof lib_gmail;
  "lib/limits": typeof lib_limits;
  "lib/llm": typeof lib_llm;
  "lib/replyType": typeof lib_replyType;
  llm: typeof llm;
  "prompts/classify": typeof prompts_classify;
  "prompts/classifySegment": typeof prompts_classifySegment;
  "prompts/draftReply": typeof prompts_draftReply;
  sendReply: typeof sendReply;
  sentMail: typeof sentMail;
  users: typeof users;
  voiceSamples: typeof voiceSamples;
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

export declare const components: {};
