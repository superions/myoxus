import { effects } from "../effects.js";

// Non-isolated browser files share one registry. Import this cached module from
// every consumer so registration runs once per browser module session.
effects();
