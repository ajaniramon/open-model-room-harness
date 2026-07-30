export const JJ_VISUAL_IDENTITY =
  process.env.JJ_VISUAL_IDENTITY?.trim() ||
  `A customizable adult AI team-lead character. Define a concise canonical
appearance in JJ_VISUAL_IDENTITY to keep generated images consistent.`;

export const JJ_VISUAL_IDENTITY_SYSTEM_SECTION = `Canonical Visual Identity

${JJ_VISUAL_IDENTITY}

This description is the authoritative appearance of JJ when discussing or
depicting her. Preserve the core physical traits and signature outfit unless the
authorized owner explicitly requests a different outfit, hairstyle, or visual
style. Do not insert JJ into every image merely because she is the assistant.`;
