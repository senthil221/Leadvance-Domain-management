export const THEME_KEY = "domain-engine-theme";

// Runs in <head> before the first paint: the saved choice, else the system setting.
export const themeScript = `(function(){try{var t=localStorage.getItem("${THEME_KEY}");if(t!=="dark"&&t!=="light")t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";document.documentElement.dataset.theme=t;}catch(e){}})();`;
