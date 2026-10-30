export const THEME_KEY = "domain-engine-theme";
export const DENSITY_KEY = "domain-engine-density";

// Runs in <head> before the first paint: the saved choice, else the system setting.
// The compact view is remembered the same way so tables never jump on load.
export const themeScript = `(function(){try{var t=localStorage.getItem("${THEME_KEY}");if(t!=="dark"&&t!=="light")t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";document.documentElement.dataset.theme=t;if(localStorage.getItem("${DENSITY_KEY}")==="compact")document.documentElement.dataset.density="compact";}catch(e){}})();`;
