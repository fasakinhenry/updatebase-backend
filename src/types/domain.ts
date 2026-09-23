/** roles inside an organization, from most to least privileged. */
export const ORG_ROLES = ["owner", "admin", "delegate"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const ROLE_RANK: Record<OrgRole, number> = {
  owner: 3,
  admin: 2,
  delegate: 1,
};

/** the opportunity categories a user picks in onboarding and an update carries. */
export const CATEGORIES = [
  "jobs",
  "internships",
  "scholarships",
  "fellowships",
  "grants",
  "career",
  "events",
  "competitions",
  "hackathons",
  "bounties",
  "conferences",
  "volunteering",
  "alpha",
] as const;
export type Category = (typeof CATEGORIES)[number];

/** the header emoji and wording each category gets by default. */
export const CATEGORY_HEADERS: Record<Category, string> = {
  jobs: "💼 job update",
  internships: "🧑‍💻 internship update",
  scholarships: "🎓 scholarship update",
  fellowships: "🌍 fellowship update",
  grants: "💰 grant update",
  career: "📈 career update",
  events: "📅 event update",
  competitions: "🏆 competition update",
  hackathons: "🚀 hackathon update",
  bounties: "🎯 bounty update",
  conferences: "🎤 conference update",
  volunteering: "🤝 volunteering update",
  alpha: "🔓 alpha",
};

export const CAREER_STAGES = [
  "student",
  "graduate",
  "postgraduate",
  "early-career",
  "mid-career",
  "senior",
] as const;
export type CareerStage = (typeof CAREER_STAGES)[number];

/** where an organization can publish. "updatebase" is always present. */
export const CHANNELS = [
  "updatebase",
  "whatsapp-channel",
  "whatsapp-group",
  "x",
  "linkedin",
  "instagram",
  "facebook",
  "telegram",
] as const;
export type Channel = (typeof CHANNELS)[number];

/** who can see a profile. org owners always see their own members. */
export const VISIBILITY = ["public", "followers", "organizations", "private"] as const;
export type Visibility = (typeof VISIBILITY)[number];

/** how tips on an update are divided. */
export const TIP_MODES = ["poster", "split", "organization"] as const;
export type TipMode = (typeof TIP_MODES)[number];

export const REACTIONS = ["love", "celebrate"] as const;
export type ReactionKind = (typeof REACTIONS)[number];

export const NOTIFICATION_KINDS = [
  "new_update",
  "follow",
  "comment",
  "comment_reply",
  "mention",
  "reaction",
  "repost",
  "quote",
  "testimonial_quote",
  "testimonial_comment",
  "org_invite",
  "org_invite_accepted",
  "tip_received",
  "feedback_received",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
