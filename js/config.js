/**
 * App configuration.
 *
 * 1. Deploy apps-script/Code.gs as a Web App (see README).
 * 2. Paste the deployment /exec URL below.
 *
 * Until you set this, the app runs in OFFLINE DEMO mode using your phone's
 * local storage so you can try the interface — but data won't sync to the sheet.
 */
window.APP_CONFIG = {
  // e.g. "https://script.google.com/macros/s/AKfy....../exec"
  API_URL: "https://script.google.com/macros/s/AKfycbyFvGswUWCeMn-jBjZcI06ajOVYmwaDp96EmOtOxA5difjG1F6gNaY0LbgCeLfSj4JphA/exec",

  CHALLENGE_LENGTH: 75,
  WATER_GOAL_ML: 4000,  // 4 L — comfortably meets the 1-gallon (3.8 L) rule
  GLASS_ML: 500,        // one tap = 500 ml (8 taps = 4 L)
  DEFAULT_THEME: "midnight",
  APP_VERSION: "2.34.0"
};
