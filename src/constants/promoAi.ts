export const AI_AVATAR_PATHS = [
  "/avatars/avatar_female.png",
  "/avatars/avatar_female_dreads.png",
  "/avatars/avatar_female_dreads2.png",
  "/avatars/avatar_male.png",
  "/avatars/avatar_male_dreads.png",
  "/avatars/avatar_male_dreads2.png",
] as const;

export const PROMO_AI_PROFILES = [
  { username: "Ace", avatarUrl: "/avatars/avatar_male.png" },
  { username: "Blaze", avatarUrl: "/avatars/avatar_female.png" },
  { username: "Cash", avatarUrl: "/avatars/avatar_male_dreads.png" },
  { username: "Drift", avatarUrl: "/avatars/avatar_female_dreads.png" },
] as const;

export const PROMO_AI_NAMES = PROMO_AI_PROFILES.map((profile) => profile.username);

export const getAiAvatarUrl = (seed: number | string) => {
  const normalizedSeed =
    typeof seed === "number"
      ? seed
      : seed.split("").reduce((total, char) => total + char.charCodeAt(0), 0);

  return AI_AVATAR_PATHS[Math.abs(normalizedSeed) % AI_AVATAR_PATHS.length];
};

export const getPromoAiProfile = (index: number) =>
  PROMO_AI_PROFILES[index % PROMO_AI_PROFILES.length];
