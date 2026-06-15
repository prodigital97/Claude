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
  API_URL: "",

  CHALLENGE_LENGTH: 75,
  WATER_GOAL_OZ: 128,   // 1 US gallon
  GLASS_OZ: 16,         // size of one tappable glass (8 glasses = 1 gallon)
  APP_VERSION: "1.0.0"
};
