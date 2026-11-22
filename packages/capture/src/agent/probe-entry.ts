import { installProbe } from "./probe.ts";

// Entry point for the conformance probe (IIFE), injected after the agent by
// `motionpr adapter check` only. Captures never load it.
installProbe(window);
