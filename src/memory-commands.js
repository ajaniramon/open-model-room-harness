import { isReadable, tokenize } from "./memory-retrieval.js";

function stripAddress(content) {
  return String(content || "")
    .trim()
    // Strip a real Discord mention or any "@handle" the operator typed, so the command
    // grammar does not depend on what the character is called.
    .replace(/^(?:<@!?\d{15,22}>|@[\w.-]{1,32})\s*[:,\-]?\s*/i, "")
    .trim();
}

// Every memory command is matched deterministically before inference, so it never
// costs provider credit and a model reply can never trigger one.
export function parseMemoryCommand(content) {
  const text = stripAddress(content);
  const flat = text.replace(/\s+/g, " ").replace(/[.!?]+$/, "").trim();
  const lower = flat.toLowerCase();

  if (/^(?:memory (?:off|disable)|desactiva(?:r)? (?:la )?memoria|no me recuerdes)$/.test(lower)) {
    return { action: "consent", enabled: false };
  }
  if (/^(?:memory (?:on|enable)|activa(?:r)? (?:la )?memoria|puedes recordarme)$/.test(lower)) {
    return { action: "consent", enabled: true };
  }
  if (/^(?:what do you remember about me|qu[eé] recuerdas de m[ií]|memory list|memoria m[ií]a)$/.test(lower)) {
    return { action: "list" };
  }
  if (
    /^(?:what do you remember(?: about (?:everyone|us|the room|this (?:channel|server)))?|list memory|memory all|qu[eé] recuerdas(?: de (?:todos|la sala|este (?:canal|servidor)))?|memoria)$/.test(
      lower,
    )
  ) {
    return { action: "list_all" };
  }
  if (/^(?:export (?:my )?memory|exporta(?:r)? (?:mi )?memoria)$/.test(lower)) {
    return { action: "export" };
  }
  if (
    /^(?:forget everything(?: about me)?|olvida(?:lo)? todo(?: sobre m[ií])?|borra (?:mi )?memoria)$/.test(
      lower,
    )
  ) {
    return { action: "forget_all" };
  }

  if (/^(?:digest(?: now)?|digiere(?: ahora)?|procesa(?:r)? (?:la )?memoria)$/.test(lower)) {
    return { action: "digest" };
  }

  const forget = /^(?:forget|olvida)\s+(?:about\s+|sobre\s+|que\s+)?(.+)$/i.exec(flat);
  if (forget) return { action: "forget", query: forget[1].trim() };

  const remember =
    /^(?:remember|recuerda|memoriza|ap[uú]ntate)\b\s*(?:that|this|que|esto)?\s*[:,]?\s*(.+)$/i.exec(
      flat,
    );
  // "remember when we broke prod?" is a question about the past, not a note to store.
  if (remember && /\?\s*$/.test(text)) return null;
  if (remember) {
    let value = remember[1].trim();
    const privateMatch = /^(?:privately|in private|en privado|solo para ti|s[oó]lo para ti)\s*[:,]?\s*(.+)$/i.exec(
      value,
    );
    if (privateMatch) return { action: "remember", text: privateMatch[1].trim(), privacy: "owner" };
    const roomMatch = /^(?:only here|just here|solo aqu[ií]|s[oó]lo aqu[ií])\s*[:,]?\s*(.+)$/i.exec(value);
    if (roomMatch) return { action: "remember", text: roomMatch[1].trim(), privacy: "room" };
    if (value.length < 3) return null;
    return { action: "remember", text: value, privacy: "guild" };
  }
  return null;
}

export function isMemoryAuthorized(author, config) {
  const id = String(author?.id || "");
  const username = String(author?.username || "").toLowerCase();
  return config.memoryAllowedUserIds.has(id) || config.memoryAllowedUsernames.has(username);
}

function describe(record) {
  return `\`${record.id.slice(4, 12)}\` (${record.createdAt.slice(0, 10)}, ${record.privacy}) ${record.text}`;
}

function findByQuery(records, query) {
  const short = query.trim().toLowerCase();
  const byId = records.filter(
    (record) => record.id === short || record.id.slice(4, 12) === short.replace(/^`|`$/g, ""),
  );
  if (byId.length) return byId;
  const tokens = new Set(tokenize(query));
  if (!tokens.size) return [];
  return records.filter((record) => {
    const recordTokens = new Set([...tokenize(record.text), ...record.keys.flatMap(tokenize)]);
    for (const token of tokens) if (recordTokens.has(token)) return true;
    return false;
  });
}

export async function executeMemoryCommand(command, store, context) {
  const { userId, displayName, guildId = null, channelId = null } = context;

  if (command.action === "consent") {
    await store.setConsent(userId, command.enabled);
    return {
      response: command.enabled
        ? "[memory enabled] I can store and recall notes about you again."
        : "[memory disabled] I will not store or recall anything about you. Existing notes stay until you ask me to forget them.",
    };
  }

  if (command.action === "list") {
    const mine = store
      .active({ subjectUserId: String(userId) })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (!mine.length) return { response: "I have no stored memory about you." };
    const shown = mine.slice(0, 10).map(describe);
    const extra = mine.length > shown.length ? `\n…and ${mine.length - shown.length} more.` : "";
    return {
      response: `**Stored memory about you (${mine.length})**\n${shown.join("\n")}${extra}\nForget one with \`forget <id>\`, or all with \`forget everything about me\`.`,
    };
  }

  if (command.action === "list_all") {
    const readable = store
      .active()
      .filter((record) => isReadable(record, { guildId, channelId, ownerTurn: context.isOwner === true }))
      .sort(
        (a, b) =>
          a.subject.displayName.localeCompare(b.subject.displayName) ||
          b.createdAt.localeCompare(a.createdAt),
      );
    if (!readable.length) return { response: "I have nothing stored that I can recall here." };
    const byPerson = new Map();
    for (const record of readable) {
      const name = record.subject.displayName || record.subject.userId;
      byPerson.set(name, [...(byPerson.get(name) || []), record]);
    }
    const sections = [...byPerson]
      .map(([name, records]) => {
        const lines = records.slice(0, 6).map((record) => `• ${record.text}`);
        const rest = records.length > lines.length ? `\n• …and ${records.length - lines.length} more` : "";
        return `**${name}**\n${lines.join("\n")}${rest}`;
      })
      .slice(0, 8);
    return {
      response: `**What I can recall here (${readable.length} note(s), ${byPerson.size} person/people)**\n${sections.join("\n")}`,
    };
  }

  if (command.action === "export") {
    const content = store.exportSubject(userId);
    return {
      response: "Here is everything I have stored about you.",
      attachment: { name: `memory-${String(userId)}.json`, content },
    };
  }

  if (command.action === "forget_all") {
    const removed = await store.forgetSubject(userId);
    return {
      response: removed
        ? `[forgotten] Deleted ${removed} stored note(s) about you.`
        : "I had nothing stored about you.",
    };
  }

  if (command.action === "forget") {
    const mine = store.active({ subjectUserId: String(userId) });
    const matches = findByQuery(mine, command.query);
    if (!matches.length) return { response: "I found no stored note matching that." };
    if (matches.length > 1) {
      return {
        response: `That matches ${matches.length} notes. Forget one by ID:\n${matches
          .slice(0, 10)
          .map(describe)
          .join("\n")}`,
      };
    }
    await store.forget(matches[0].id);
    return { response: `[forgotten] ${matches[0].text}` };
  }

  if (command.action === "remember") {
    if (store.isOptedOut(userId)) {
      return {
        response: "Memory is disabled for you. Say `memory on` first if you want me to store this.",
      };
    }
    const record = await store.remember({
      text: command.text,
      subject: { userId: String(userId), displayName },
      scope: { guildId, channelId },
      privacy: guildId ? command.privacy : "owner",
      significance: 4,
      source: { channelId, messageId: context.messageId, origin: "explicit" },
    });
    const reach =
      record.privacy === "guild"
        ? "every channel in this server"
        : record.privacy === "room"
          ? "this channel only"
          : "our private turns only";
    return {
      response: `[remembered] ${record.text}\nScope: ${reach}. ID \`${record.id.slice(4, 12)}\`.`,
    };
  }

  throw new Error(`Unsupported memory command: ${command.action}`);
}
