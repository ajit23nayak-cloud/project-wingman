import { v } from "convex/values";
import { action } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { draftReplyContent } from "./prompts/draftReply";
import {
  classifySegmentContent,
  type Segment,
} from "./prompts/classifySegment";
import { classifyReplyType } from "./lib/replyType";

const GEMINI_TIMEOUT_MS = 30_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error(`timeout after ${ms}ms (${label})`)),
        ms,
      ),
    ),
  ]);
}

function resolveFirstName(identity: {
  givenName?: string;
  name?: string;
}): string {
  if (identity.givenName && identity.givenName.length > 0) {
    return identity.givenName;
  }
  if (identity.name && identity.name.length > 0) {
    const first = identity.name.split(" ")[0];
    if (first && first.length > 0) return first;
  }
  return "there";
}

export const generateDraftReply = action({
  args: { emailId: v.id("emails") },
  handler: async (ctx, { emailId }): Promise<string | null> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    try {
      const user = await ctx.runQuery(internal.users.getByClerkIdInternal, {
        clerkUserId: identity.subject,
      });
      if (!user) return null;

      const email = await ctx.runQuery(internal.inbox.getEmailByIdInternal, {
        emailId,
      });
      if (!email) return null;
      if (email.userId !== user._id) return null;

      // Fetch full body via the public fetchEmailBody action. ctx.auth carries
      // through ctx.runAction, so the action's own auth gate sees this user.
      // Falls back to the stored snippet on error or empty body.
      let bodyText = email.snippet ?? "";
      try {
        const bodyResult = await ctx.runAction(api.emailBody.fetchEmailBody, {
          emailId,
        });
        if (bodyResult && !bodyResult.error && bodyResult.bodyText) {
          bodyText = bodyResult.bodyText;
        }
      } catch (err) {
        console.error("[generateDraftReply] body fetch failed", {
          emailId,
          error: err instanceof Error ? err.message : String(err),
        });
        // Continue with snippet fallback.
      }

      // Segment the INCOMING email so we can pull matching voice samples.
      // On failure (or empty body) fall back to internal_team — Ajit's most
      // populated bucket, so the selection rule still produces something
      // usable.
      let segment: Segment = "internal_team";
      let segmentInputTokens = 0;
      let segmentOutputTokens = 0;
      if (bodyText.trim().length === 0) {
        console.warn(
          "[generateDraftReply] empty body for segment classify, using internal_team fallback",
          { emailId },
        );
      } else {
        try {
          const { result, usage } = await withTimeout(
            classifySegmentContent({
              subject: email.subject,
              bodyText,
            }),
            GEMINI_TIMEOUT_MS,
            `classifySegment ${emailId}`,
          );
          segment = result.segment;
          segmentInputTokens = usage.inputTokens ?? 0;
          segmentOutputTokens = usage.outputTokens ?? 0;
        } catch (err) {
          console.error(
            "[generateDraftReply] segment classify failed, falling back to internal_team",
            {
              emailId,
              error: err instanceof Error ? err.message : String(err),
            },
          );
        }
      }

      const replyType = classifyReplyType(bodyText);

      const selection = await ctx.runQuery(
        internal.voiceSamples.listForDraftSelectionInternal,
        { userId: user._id, segment, replyType },
      );

      const firstName = resolveFirstName({
        givenName: identity.givenName as string | undefined,
        name: identity.name as string | undefined,
      });

      const { text, usage } = await withTimeout(
        draftReplyContent({
          userFirstName: firstName,
          voiceSnippets: selection.snippets,
          segment: selection.segmentUsed ?? undefined,
          fromAddress: email.fromAddress,
          subject: email.subject,
          bodyText,
        }),
        GEMINI_TIMEOUT_MS,
        `draftReply ${emailId}`,
      );

      if (!text || text.length === 0) {
        console.error("[generateDraftReply] empty draft", { emailId });
        return null;
      }

      console.log("[generateDraftReply] drafted", {
        emailId,
        selectionPath: selection.selectionPath,
        segmentUsed: selection.segmentUsed,
        replyType,
        snippetCount: selection.snippets.length,
        inputTokens: (usage.inputTokens ?? 0) + segmentInputTokens,
        outputTokens: (usage.outputTokens ?? 0) + segmentOutputTokens,
      });

      await ctx.runMutation(internal.inbox.applyDraftReply, {
        emailId,
        draft: text,
        generatedAt: Date.now(),
        segmentUsed: selection.segmentUsed ?? undefined,
        snippetIndicesUsed:
          selection.snippetIds.length > 0 ? selection.snippetIds : undefined,
      });

      return text;
    } catch (err) {
      console.error("[generateDraftReply] failed", {
        emailId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  },
});
