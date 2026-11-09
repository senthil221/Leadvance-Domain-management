// The endings used for replacement domains. Free domains on any other ending
// (.link, .xyz and so on) stay out of the way: hidden on Free domains unless
// asked for, and never offered in the replace window.
export const REPLACEMENT_TLDS = ["com", "co", "info", "pro", "org", "net"] as const;

const allowed = new Set<string>(REPLACEMENT_TLDS);

export const isReplacementTld = (tld: string | null | undefined) => !!tld && allowed.has(tld.toLowerCase());
