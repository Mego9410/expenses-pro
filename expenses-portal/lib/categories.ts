export const CATEGORIES = [
  "Advertising",
  "Business Development",
  "Card charges",
  "Donations",
  "Entertaining",
  "Gifts",
  "Hotels",
  "IT",
  "LLP",
  "Marketing and PR",
  "Office refreshments",
  "Other travel",
  "Parking",
  "Petty Cash",
  "Postage",
  "Premises expenses",
  "Principals Club",
  "Property repairs/renewals",
  "Stationery",
  "Subscriptions",
  "Subsistence",
  "Trains",
  "Training",
] as const;

export type Category = (typeof CATEGORIES)[number];

const normalize = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]/g, "");

const NORMALIZED_MAP = new Map<string, Category>(
  CATEGORIES.map((c) => [normalize(c), c]),
);

// Fallback fuzzy match in case the model returns a near-miss
export function coerceCategory(raw: string): Category {
  const n = normalize(raw);
  if (NORMALIZED_MAP.has(n)) return NORMALIZED_MAP.get(n)!;

  // Token-overlap heuristic
  const rawTokens = new Set(raw.toLowerCase().split(/\W+/).filter(Boolean));
  let best: Category = "Subsistence";
  let bestScore = 0;
  for (const c of CATEGORIES) {
    const cTokens = c.toLowerCase().split(/\W+/).filter(Boolean);
    const overlap = cTokens.filter((t) => rawTokens.has(t)).length;
    if (overlap > bestScore) {
      bestScore = overlap;
      best = c;
    }
  }
  return best;
}
