// Reply-type heuristic — shared by sentMail ingest (classifies the user's own
// sent snippets at ingest time) and draftReply (classifies the INCOMING email
// to pick a matching segment×intent voice sample bucket). Pure function so
// both the "use node" sentMail module and the default-runtime callers can
// import it. Pattern order matters: earlier rules win on ambiguous bodies.

export type ReplyType = "ack" | "decline" | "question" | "propose" | "info";

export function classifyReplyType(snippet: string): ReplyType {
  const text = snippet.trim();
  const lower = text.toLowerCase();

  if (
    /\b(unfortunately|won['’]?t be able|can['’]?t make|have to (pass|decline)|going to pass|not a fit|not the right (time|fit)|won['’]?t work for (us|me))\b/.test(
      lower,
    )
  ) {
    return "decline";
  }

  if (
    /\b(let['’]?s (meet|chat|sync|hop on|jump on|grab (a )?(call|coffee))|how about|would you be (free|available|open)|are you (free|available|open) (on|next|this|tomorrow)|propose (a |we )|book(ing)? (a )?(call|time|slot))\b/.test(
      lower,
    )
  ) {
    return "propose";
  }

  const hasQuestionMark = text.includes("?");
  if (
    hasQuestionMark ||
    /\b(could you|can you|would you mind|wondering (if|whether)|curious (whether|if|about)|quick question|any chance)\b/.test(
      lower,
    )
  ) {
    return "question";
  }

  if (
    text.length < 120 &&
    /^(thanks|thank you|got it|sounds good|sure|noted|appreciate|will do|cheers|perfect|great|awesome)/i.test(
      text,
    )
  ) {
    return "ack";
  }

  return "info";
}
