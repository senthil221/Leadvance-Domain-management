// Which company this server belongs to, so two tabs never look alike.
// Set APP_BRAND in deploy/app/.env; it is baked in when the image is built.
export type Brand = { name: string; letter: string | null; color: string | null; icon: string };

const BRANDS: Record<string, Brand> = {
  leadvance: { name: "Leadvance Domains", letter: "L", color: "#2563eb", icon: "/brand/leadvance.svg" },
  b2bdrive: { name: "B2bdrive Domains", letter: "B", color: "#ea580c", icon: "/brand/b2bdrive.svg" },
};

export const brand: Brand = BRANDS[process.env.NEXT_PUBLIC_APP_BRAND ?? ""] ?? {
  name: "Domain Engine",
  letter: null,
  color: null,
  icon: "/brand/default.svg",
};
